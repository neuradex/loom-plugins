import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync, statSync, openSync, closeSync, readSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { accountKey, digest, type Config } from "./config.js";
import { readSettings } from "./settings.js";

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
	segment: string; last_seen: number; ended: number; error: string | null; tail_hash: string; sealed: number;
	client_context: string | null;
}
export interface QueueRow { id: string; body: string; bytes: number; segment: string }

interface FileStat {
	/** Exact `dev:ino`, from BigInt stats so NTFS ids above 2^53 stay distinct. */
	identity: string;
	/** The form collect() stores in sources.identity (numeric stats). It equals
	 * `identity` below 2^53; above that it is rounded and can name another file. */
	recorded: string;
	/** dev and ino are safe integers: no other id rounds to this one's recorded
	 * form. 2^53 itself is exact but is also what 2^53+1 rounds to. */
	unambiguous: boolean;
	size: number;
}
function fileStat(path: string): FileStat | undefined {
	try {
		const stat = statSync(path, { bigint: true });
		// Filesystems without stable file ids (SMB, FAT, some FUSE) report ino 0 for
		// every file; such a path keeps its own source, keyed by path.
		if (stat.ino === 0n) return undefined;
		const safe = BigInt(Number.MAX_SAFE_INTEGER);
		return { identity: `${stat.dev}:${stat.ino}`, recorded: `${Number(stat.dev)}:${Number(stat.ino)}`,
			unambiguous: stat.dev <= safe && stat.ino <= safe, size: Number(stat.size) };
	} catch { return undefined; }
}
/** Digest of the bytes before a cursor, which collect() records to detect a file
 * truncated and regrown in place. */
export function tailHash(fd: number, position: number): string {
	const tail = Buffer.alloc(Math.min(64, position));
	readSync(fd, tail, 0, tail.length, position - tail.length);
	return digest(tail.toString("base64"));
}
/** Whether collect() would continue this source's cursor on the file as it is now
 * rather than restart it at byte 0. */
function cursorHolds(source: Source, file: FileStat): boolean {
	if (source.identity !== file.recorded || source.offset > file.size) return false;
	if (!source.offset || !source.tail_hash) return true;
	try {
		const fd = openSync(source.path, "r");
		try { return tailHash(fd, source.offset) === source.tail_hash; } finally { closeSync(fd); }
	} catch { return false; }
}

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
			CREATE TABLE IF NOT EXISTS project_sessions (session TEXT PRIMARY KEY, cwd TEXT NOT NULL, file TEXT, graph TEXT);
			CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS bug_report_drafts (id TEXT PRIMARY KEY, payload TEXT NOT NULL,
			 state TEXT NOT NULL, result TEXT, expires INTEGER NOT NULL);
		`);
		this.addSourceColumn("sealed", "INTEGER NOT NULL DEFAULT 0");
		this.addSourceColumn("client_context", "TEXT");
		this.db.exec("CREATE TABLE IF NOT EXISTS project_graphs (graph TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS graph_switches (session TEXT PRIMARY KEY, value TEXT NOT NULL)");

	}
	/** Concurrent hook processes may open a pre-migration store at the same time. */
	private addSourceColumn(name: string, definition: string): void {
		const exists = () => this.db.prepare("PRAGMA table_info(sources)").all().some(row => row.name === name);
		if (exists()) return;
		try { this.db.exec(`ALTER TABLE sources ADD COLUMN ${name} ${definition}`); }
		catch (error) { if (!exists()) throw error; }
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
	/** One source per transcript file in a host session. Orca's profile homes reach
	 * ~/.claude/projects through a symlink, so a session that moves profile reports
	 * another path for the same file: that path reuses the source and its cursor
	 * instead of re-reading the file from byte 0. The id scheme is unchanged so that
	 * existing sources keep their cursors. */
	source(session: string, path: string, context?: string): Source {
		const id = digest(JSON.stringify([session, path]));
		return this.transaction(() => {
			const existing = this.db.prepare("SELECT * FROM sources WHERE id=?").get(id) as unknown as Source | undefined;
			if (existing && !existing.sealed) return this.tag(existing, context);
			const alias = path ? this.alias(session, id, path) : undefined;
			if (alias) return this.tag(alias, context);
			// A source sealed by a graph switch stays sealed.
			if (existing) return existing;
			const segment = `agent:${randomUUID()}`;
			this.db.prepare("INSERT INTO sources(id,session,path,segment,last_seen,client_context) VALUES (?,?,?,?,?,?)")
				.run(id, session, path, segment, Date.now(), context ?? null);
			this.db.prepare("INSERT INTO segments(id,source) VALUES (?,?)").run(segment, id);
			return this.db.prepare("SELECT * FROM sources WHERE id=?").get(id) as unknown as Source;
		});
	}
	/** The session's live source for the same file as `path`, by its current path or
	 * by the identity its last read recorded. When its stored path no longer names
	 * that file (the profile directory it went through was removed), the source
	 * follows the file to `path`, so the stored path always names the file its
	 * cursor describes. */
	private alias(session: string, id: string, path: string): Source | undefined {
		const target = fileStat(path);
		if (!target) return undefined;
		for (const source of this.db.prepare("SELECT * FROM sources WHERE session=? AND id<>? AND sealed=0 AND path<>'' ORDER BY offset DESC")
			.all(session, id) as unknown as Source[]) {
			if (fileStat(source.path)?.identity === target.identity) return source;
			// A rounded recorded identity cannot tell this file from its neighbours.
			if (!target.unambiguous || source.identity !== target.recorded) continue;
			this.db.prepare("UPDATE sources SET path=? WHERE id=?").run(path, source.id);
			return { ...source, path };
		}
		return undefined;
	}
	/** Sessions that started before 0.4.1 are labelled on their next hook. */
	private tag(source: Source, context?: string): Source {
		if (!context || source.client_context) return source;
		this.db.prepare("UPDATE sources SET client_context=? WHERE id=?").run(context, source.id);
		return { ...source, client_context: context };
	}
	/** Stores written before 0.4.1 can hold two live sources for one transcript file,
	 * both polled forever and each uploading every line. Keep the furthest cursor that
	 * is valid for the file as it is now, and seal the rest the way a graph switch
	 * does: rows they already queued still upload and their segments still receive a
	 * session-end, but no line is read a second time. */
	collapseDuplicateSources(): number {
		return this.transaction(() => {
			const sessions = this.db.prepare("SELECT session FROM sources WHERE sealed=0 AND path<>'' GROUP BY session HAVING count(*)>1")
				.all() as Array<{ session: string }>;
			let sealed = 0;
			for (const { session } of sessions) {
				const groups = new Map<string, { file: FileStat; sources: Source[] }>();
				for (const source of this.db.prepare("SELECT * FROM sources WHERE session=? AND sealed=0 AND path<>''").all(session) as unknown as Source[]) {
					const file = fileStat(source.path);
					if (file) groups.set(file.identity, { file, sources: [...groups.get(file.identity)?.sources ?? [], source] });
				}
				for (const { file, sources: group } of groups.values()) {
					// A cursor recorded for another generation of the file restarts at byte 0.
					const rank = (source: Source) => [cursorHolds(source, file) ? 1 : 0, source.offset] as const;
					const keep = group.reduce((best, source) => {
						const [valid, offset] = rank(source); const [bestValid, bestOffset] = rank(best);
						return valid > bestValid || (valid === bestValid && offset > bestOffset) ? source : best;
					});
					for (const source of group.filter(source => source.id !== keep.id)) {
						this.db.prepare("UPDATE sources SET sealed=1,ended=1,error=NULL,path='' WHERE id=?").run(source.id);
						this.db.prepare("UPDATE segments SET closed=1 WHERE source=?").run(source.id);
						sealed++;
					}
				}
			}
			return sealed;
		});
	}
	sources(): Source[] {
		return this.db.prepare("SELECT * FROM sources").all() as unknown as Source[];
	}
	/** Called inside the cursor transaction. Closed ingestion segments are immutable;
 * resumed host sessions get another segment while metadata retains the host id. */
	append(source: Source, event: Omit<Episode, "session_id">): void {
		if (source.sealed) throw new Error("This capture source belongs to an earlier graph segment.");
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
			...readSettings(this.home),
			recall: this.get("recall", { status: "not_attempted" }),
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
