import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, symlinkSync, unlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/agent/store.js";
import { validateConfig } from "../src/agent/config.js";
import { collect, collectAll } from "../src/agent/collector.js";
import { drain } from "../src/agent/delivery.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
const line = (n: number) => JSON.stringify({ type: "user", uuid: `u${n}`, message: { role: "user", content: `line ${n}` } }) + "\n";
const contents = (store: Store) => store.batch().map((row) => JSON.parse(JSON.parse(row.body).content).uuid);

/** Orca: claude-profiles/<id>/home/projects is a symlink to ~/.claude/projects. */
function profiles() {
	const dir = mkdtempSync(join(tmpdir(), "loom-dedupe-test-"));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	const store = new Store(dir, validateConfig({ token: "test-token", url: "http://127.0.0.1:9999" }));
	cleanup.push(() => store.close());
	mkdirSync(join(dir, "real"));
	const real = join(dir, "real", "session.jsonl"); writeFileSync(real, "");
	symlinkSync(join(dir, "real"), join(dir, "profile-a"));
	symlinkSync(join(dir, "real"), join(dir, "profile-b"));
	return { dir, store, real, a: join(dir, "profile-a", "session.jsonl"), b: join(dir, "profile-b", "session.jsonl") };
}
/** A source registered by 0.4.0, which keyed sources by path alone and so
 * registered a second source for the same file under another path. */
function legacySource(store: Store, session: string, path: string): string {
	const id = randomUUID(); const segment = `agent:${randomUUID()}`;
	store.db.prepare("INSERT INTO sources(id,session,path,segment,last_seen) VALUES (?,?,?,?,?)").run(id, session, path, segment, Date.now());
	store.db.prepare("INSERT INTO segments(id,source) VALUES (?,?)").run(segment, id);
	return id;
}
function successful(requests: Array<{ path: string; body: any }>): typeof fetch {
	return (async (url, init) => {
		const path = new URL(String(url)).pathname; const body = JSON.parse(init!.body as string);
		requests.push({ path, body });
		return Response.json(path.endsWith("/batch") ? {
			results: body.episodes.map((ep: any, i: number) => ({ idempotency_key: ep.idempotency_key, episode_id: i + 1 })),
		} : { enqueued: true });
	}) as typeof fetch;
}

describe("one source per transcript file", () => {
	it("reuses the source and cursor when a session reaches its transcript through another profile's symlink", () => {
		const { store, a, b } = profiles();
		writeFileSync(a, line(1) + line(2));
		const first = store.source("bot", a); collect(store, first.id);
		const second = store.source("bot", b);
		expect(second.id).toBe(first.id);
		expect(second.path).toBe(a);
		appendFileSync(b, line(3));
		collect(store, second.id); collectAll(store);
		expect(contents(store)).toEqual(["u1", "u2", "u3"]);
		expect(store.sources()).toHaveLength(1);
	});
	it("follows the session to its new path when the profile link it was read through is removed", () => {
		const { store, a, b, dir } = profiles();
		writeFileSync(a, line(1) + line(2));
		const first = store.source("bot", a); collect(store, first.id);
		const offset = store.sources()[0]!.offset;
		unlinkSync(join(dir, "profile-a"));
		const moved = store.source("bot", b);
		expect(moved.id).toBe(first.id);
		expect(moved.path).toBe(b);
		expect(store.sources()).toEqual([expect.objectContaining({ id: first.id, path: b, offset })]);
		appendFileSync(b, line(3));
		collect(store, moved.id);
		expect(contents(store)).toEqual(["u1", "u2", "u3"]);
	});
	it("follows the file when its stored path now names another file", () => {
		const { store, real, dir } = profiles();
		writeFileSync(real, line(1));
		const first = store.source("bot", real); collect(store, first.id);
		const moved = join(dir, "real", "moved.jsonl");
		renameSync(real, moved); writeFileSync(real, line(9));
		expect(store.source("bot", moved)).toMatchObject({ id: first.id, path: moved });
		appendFileSync(moved, line(2)); collect(store, first.id);
		expect(contents(store)).toEqual(["u1", "u2"]);
	});
	it("does not alias across sessions or to a different file", () => {
		const { store, a, dir } = profiles();
		const other = join(dir, "real", "other.jsonl"); writeFileSync(other, "");
		const source = store.source("bot", a);
		expect(store.source("another-session", a).id).not.toBe(source.id);
		expect(store.source("bot", other).id).not.toBe(source.id);
	});
	it("never aliases a session's transcript-less hook source", () => {
		const { store, a } = profiles();
		const transcript = store.source("bot", a);
		const hookOnly = store.source("bot", "");
		expect(hookOnly.id).not.toBe(transcript.id);
		expect(hookOnly.path).toBe("");
	});
	it("does not treat two unreadable paths as one file", () => {
		const { store, dir } = profiles();
		const gone = store.source("bot", join(dir, "gone-a.jsonl"));
		expect(store.source("bot", join(dir, "gone-b.jsonl")).id).not.toBe(gone.id);
		expect(store.source("bot", "").id).not.toBe(gone.id);
	});
	it("does not alias a source that a graph switch has sealed but not yet activated", () => {
		const { store, a, b } = profiles();
		// routing.ts installs the destination source sealed, with its path, before activating it.
		const pending = legacySource(store, "bot", a);
		store.db.prepare("UPDATE sources SET sealed=1 WHERE id=?").run(pending);
		expect(store.source("bot", b).id).not.toBe(pending);
	});
});

describe("collapsing duplicate sources from earlier versions", () => {
	it("keeps the furthest cursor, seals the other, and still finalizes its segment", async () => {
		const { store, a, b } = profiles();
		writeFileSync(a, line(1));
		const behind = legacySource(store, "bot", b); collect(store, behind);
		appendFileSync(a, line(2));
		const ahead = legacySource(store, "bot", a); collect(store, ahead);
		store.ack(store.batch());
		expect(store.collapseDuplicateSources()).toBe(1);
		const rows = Object.fromEntries(store.sources().map((source) => [source.id, source]));
		expect(rows[ahead]).toMatchObject({ sealed: 0, path: a });
		expect(rows[behind]).toMatchObject({ sealed: 1, ended: 1, path: "" });
		expect(store.db.prepare("SELECT closed FROM segments WHERE source=?").get(behind)!.closed).toBe(1);
		appendFileSync(a, line(3)); collectAll(store);
		expect(contents(store)).toEqual(["u3"]);
		const requests: Array<{ path: string; body: any }> = []; await drain(store, successful(requests), true);
		expect(requests.filter((r) => r.path === "/ingest/session-end").map((r) => r.body.session_id))
			.toContain(rows[behind]!.segment);
	});
	it("prefers a cursor that is valid for the current file over a further one from another generation", () => {
		const { store, a, b } = profiles();
		writeFileSync(a, line(1));
		const valid = legacySource(store, "bot", a); collect(store, valid);
		store.ack(store.batch());
		appendFileSync(a, line(2) + line(3));
		const stale = legacySource(store, "bot", b);
		store.db.prepare("UPDATE sources SET identity='0:0',offset=? WHERE id=?").run(Buffer.byteLength(line(1) + line(2)), stale);
		store.collapseDuplicateSources();
		expect(store.sources().find((source) => !source.sealed)?.id).toBe(valid);
		collectAll(store);
		expect(contents(store)).toEqual(["u2", "u3"]);
	});
	it("does not keep a cursor past the end of the file", () => {
		const { store, a, b } = profiles();
		writeFileSync(a, line(1));
		const valid = legacySource(store, "bot", a); collect(store, valid);
		store.ack(store.batch());
		const beyond = legacySource(store, "bot", b);
		const { identity } = store.sources().find((source) => source.id === valid)!;
		store.db.prepare("UPDATE sources SET identity=?,offset=? WHERE id=?").run(identity, 1_000_000, beyond);
		store.collapseDuplicateSources();
		expect(store.sources().find((source) => !source.sealed)?.id).toBe(valid);
		appendFileSync(a, line(2)); collectAll(store);
		expect(contents(store)).toEqual(["u2"]);
	});
	it("runs before polling on every drain, so a pre-0.4.1 pair stops uploading twice", async () => {
		const { store, a, b } = profiles();
		writeFileSync(a, line(1));
		legacySource(store, "bot", a); legacySource(store, "bot", b);
		const requests: Array<{ path: string; body: any }> = []; await drain(store, successful(requests), true);
		const uploaded = requests.filter((r) => r.path === "/ingest/episodes/batch").flatMap((r) => r.body.episodes);
		expect(uploaded).toHaveLength(1);
	});
	it("leaves different transcripts of one session and unreadable paths alone", () => {
		const { store, a, dir } = profiles();
		const other = join(dir, "real", "other.jsonl"); writeFileSync(other, "");
		legacySource(store, "bot", a); legacySource(store, "bot", other);
		legacySource(store, "bot", join(dir, "missing.jsonl")); legacySource(store, "bot", join(dir, "missing.jsonl"));
		expect(store.collapseDuplicateSources()).toBe(0);
		expect(store.sources().every((source) => !source.sealed)).toBe(true);
	});
	it("routes a hook that still reports the sealed path to the surviving source", () => {
		const { store, a, b } = profiles();
		writeFileSync(a, line(1));
		const first = store.source("bot", a); collect(store, first.id);
		const legacy = legacySource(store, "bot", b);
		store.collapseDuplicateSources();
		expect(store.sources().find((source) => source.id === legacy)?.sealed).toBe(1);
		expect(store.source("bot", b).id).toBe(first.id);
	});
});
