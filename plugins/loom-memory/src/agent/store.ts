import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { accountKey, digest, type Config } from "./config.js";

export interface Episode {
	idempotency_key: string;
	session_id: string;
	actor_type: "user" | "assistant" | "tool" | "system";
	type: string;
	content: string;
	metadata: Record<string, unknown>;
	created_at?: string;
}
export interface Source {
	id: string; session: string; path: string; offset: number; identity: string;
	segment: string; last_seen: number; ended: number; error: string | null; tail_hash: string;
}
export interface QueueRow { id: string; body: string; bytes: number; segment: string }

/** SQLite transactions bind the source cursor to its durable outbox. A crash can
 * replay a record, but cannot advance a cursor past an event that was not queued. */
export class Store {
	readonly db: DatabaseSync;
	constructor(readonly home: string, readonly config: Config) {
		const dir = join(home, "accounts", accountKey(config));
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		this.db = new DatabaseSync(join(dir, "capture.sqlite"));
		chmodSync(join(dir, "capture.sqlite"), 0o600);
		this.db.exec(`
			PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
			CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, session TEXT NOT NULL,
			 path TEXT NOT NULL, offset INTEGER NOT NULL DEFAULT 0, identity TEXT NOT NULL DEFAULT '', tail_hash TEXT NOT NULL DEFAULT '',
			 segment TEXT NOT NULL, last_seen INTEGER NOT NULL, ended INTEGER NOT NULL DEFAULT 0,
			 checkpoint INTEGER NOT NULL DEFAULT 0, error TEXT);
			CREATE TABLE IF NOT EXISTS segments (id TEXT PRIMARY KEY, source TEXT NOT NULL,
			 closed INTEGER NOT NULL DEFAULT 0, finalized INTEGER NOT NULL DEFAULT 0,
			 created_at INTEGER NOT NULL DEFAULT (unixepoch()*1000));
			CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT,
			 id TEXT UNIQUE NOT NULL, segment TEXT NOT NULL, body TEXT NOT NULL, bytes INTEGER NOT NULL,
			 queued_at INTEGER NOT NULL DEFAULT (unixepoch()*1000));
			CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, session TEXT NOT NULL,
			 context TEXT NOT NULL, offered TEXT NOT NULL, picked TEXT, state TEXT NOT NULL DEFAULT 'open');
			CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		`);
	}
	close(): void { this.db.close(); }
	transaction<T>(fn: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try { const result = fn(); this.db.exec("COMMIT"); return result; }
		catch (error) { this.db.exec("ROLLBACK"); throw error; }
	}
	get<T>(key: string, fallback: T): T {
		const row = this.db.prepare("SELECT value FROM settings WHERE key=?").get(key);
		return row ? JSON.parse(row.value as string) as T : fallback;
	}
	set(key: string, value: unknown): void {
		this.db.prepare("INSERT OR REPLACE INTO settings VALUES (?,?)").run(key, JSON.stringify(value));
	}
	source(session: string, path: string): Source {
		const id = digest(JSON.stringify([session, path]));
		return this.transaction(() => {
			const existing = this.db.prepare("SELECT * FROM sources WHERE id=?").get(id) as unknown as Source | undefined;
			if (existing) return existing;
			const segment = `agent:${randomUUID()}`;
			this.db.prepare("INSERT INTO sources(id,session,path,segment,last_seen) VALUES (?,?,?,?,?)")
				.run(id, session, path, segment, Date.now());
			this.db.prepare("INSERT INTO segments(id,source) VALUES (?,?)").run(segment, id);
			return this.db.prepare("SELECT * FROM sources WHERE id=?").get(id) as unknown as Source;
		});
	}
	sources(): Source[] {
		return this.db.prepare("SELECT * FROM sources").all() as unknown as Source[];
	}
	/** Called inside the cursor transaction. Closed ingestion segments are immutable;
 * resumed host sessions get another segment while metadata retains the host id. */
	append(source: Source, event: Omit<Episode, "session_id">): void {
		if (this.db.prepare("SELECT 1 FROM outbox WHERE id=?").get(event.idempotency_key)) return;
		const closed = this.db.prepare("SELECT closed FROM segments WHERE id=?").get(source.segment);
		if (closed?.closed) {
			source.segment = `agent:${randomUUID()}`;
			this.db.prepare("INSERT INTO segments(id,source) VALUES (?,?)").run(source.segment, source.id);
			this.db.prepare("UPDATE sources SET segment=?,ended=0 WHERE id=?").run(source.segment, source.id);
		}
		const body = JSON.stringify({ ...event, session_id: source.segment });
		const bytes = Buffer.byteLength(body);
		const pending = this.get("queueBytes", 0);
		if (pending + bytes > this.config.maxQueueBytes) {
			throw new Error("Capture queue is full. Source cursor retained; free disk space or restore uploads, then flush. No event was sampled away.");
		}
		this.db.prepare("INSERT OR IGNORE INTO outbox(id,segment,body,bytes) VALUES (?,?,?,?)")
			.run(event.idempotency_key, source.segment, body, bytes);
		this.set("queueBytes", pending + bytes);
		this.db.prepare("UPDATE sources SET last_seen=?,error=NULL WHERE id=?").run(Date.now(), source.id);
	}
	markEnded(session: string): void {
		this.db.prepare("UPDATE sources SET ended=1 WHERE session=?").run(session);
	}
	closeIdleSegments(now = Date.now()): void {
		// Only close after the collector has caught up (the caller checks the file).
		this.db.prepare(`UPDATE segments SET closed=1 WHERE id IN
		 (SELECT source.segment FROM sources source JOIN segments segment ON segment.id=source.segment
		 WHERE source.error IS NULL AND (source.ended=1 OR source.last_seen<?
		 OR (source.checkpoint=1 AND segment.created_at<?)))`)
			.run(now - this.config.segmentIdleMs, now - this.config.segmentMaxMs);
	}
	batch(): QueueRow[] {
		const rows = this.db.prepare("SELECT id,body,bytes,segment FROM outbox ORDER BY seq LIMIT ?")
			.all(this.config.batchEvents) as unknown as QueueRow[];
		const batch: QueueRow[] = []; let bytes = Buffer.byteLength('{"episodes":[]}');
		for (const row of rows) {
			if (bytes + row.bytes + 1 > this.config.batchBytes) break;
			batch.push(row); bytes += row.bytes + 1;
		}
		return batch;
	}
	ack(rows: QueueRow[]): void {
		this.transaction(() => {
			for (const row of rows) this.db.prepare("DELETE FROM outbox WHERE id=?").run(row.id);
			this.set("queueBytes", this.get("queueBytes", 0) - rows.reduce((n, row) => n + row.bytes, 0));
		});
	}
	status(): Record<string, unknown> {
		return {
			queue: this.db.prepare("SELECT COUNT(*) events,COALESCE(SUM(bytes),0) bytes,MIN(queued_at) oldest_queued_at FROM outbox").get(),
			sources: this.db.prepare("SELECT COUNT(*) total,SUM(error IS NOT NULL) blocked FROM sources").get(),
			blockedSources: this.db.prepare("SELECT id,offset,error FROM sources WHERE error IS NOT NULL LIMIT 20").all(),
			segments: this.db.prepare("SELECT COUNT(*) pending FROM segments WHERE closed=1 AND finalized=0").get(),
			delivery: this.get("delivery", {}),
			metrics: this.get("metrics", {}),
			usage: this.db.prepare("SELECT state,COUNT(*) count FROM receipts GROUP BY state").all(),
		};
	}
}
