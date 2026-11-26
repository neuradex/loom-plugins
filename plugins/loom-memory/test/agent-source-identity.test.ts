import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** NTFS file ids can exceed 2^53, which tests cannot create on disk. Paths named
 * big-*.jsonl report such an id; collect() would record it rounded. Paths named
 * noid-*.jsonl report ino 0, as SMB, FAT and some FUSE filesystems do for every file. */
const BIG = 9_007_199_254_740_993n;
vi.mock("node:fs", async (original) => {
	const fs = await original<typeof import("node:fs")>();
	const statSync = ((path: string, options?: { bigint?: boolean }) => {
		if (/noid-\w+\.jsonl$/.test(String(path)) && options?.bigint) return { ...fs.statSync(path, { bigint: true }), dev: 1n, ino: 0n };
		const match = /big-(\d+)\.jsonl$/.exec(String(path));
		if (!match || !options?.bigint) return fs.statSync(path, options as never);
		const real = fs.statSync(path, { bigint: true });
		return { ...real, dev: 1n, ino: BIG + BigInt(match[1]!) - 1n, size: real.size };
	}) as typeof fs.statSync;
	return { ...fs, default: { ...fs, statSync }, statSync };
});
const { Store } = await import("../src/agent/store.js");
const { validateConfig } = await import("../src/agent/config.js");

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "loom-identity-test-"));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	const store = new Store(dir, validateConfig({ token: "test-token", url: "http://127.0.0.1:9999" }));
	cleanup.push(() => store.close());
	return { dir, store };
}
function source(store: InstanceType<typeof Store>, session: string, path: string, identity: string, offset: number): string {
	const id = randomUUID(); const segment = `agent:${randomUUID()}`;
	store.db.prepare("INSERT INTO sources(id,session,path,offset,identity,segment,last_seen) VALUES (?,?,?,?,?,?,?)")
		.run(id, session, path, offset, identity, segment, Date.now());
	store.db.prepare("INSERT INTO segments(id,source) VALUES (?,?)").run(segment, id);
	return id;
}
const ROUNDED = `1:${Number(BIG)}`;

describe("file ids above 2^53", () => {
	it("does not move a source to another file whose id rounds to the one it recorded", () => {
		const { store, dir } = fixture();
		const gone = join(dir, "removed.jsonl");
		const other = join(dir, "big-1.jsonl"); writeFileSync(other, "{}\n");
		// The source read a file with id 2^53 (stored exactly as ROUNDED); big-1 has id 2^53+1.
		const existing = source(store, "s", gone, ROUNDED, 3);
		expect(store.source("s", other).id).not.toBe(existing);
		expect(store.sources().find((row) => row.id === existing)?.path).toBe(gone);
	});
	it("does not move a source whose rounded identity equals another file's exact 2^53 id", () => {
		const { store, dir } = fixture();
		const gone = join(dir, "removed.jsonl");
		const other = join(dir, "big-0.jsonl"); writeFileSync(other, "{}\n");
		// The source read a file with id 2^53+1, recorded as ROUNDED; big-0 has id exactly 2^53.
		const existing = source(store, "s", gone, ROUNDED, 3);
		expect(store.source("s", other).id).not.toBe(existing);
	});
	it("ranks a cursor by the identity form collect() recorded", () => {
		const { store, dir } = fixture();
		const path = join(dir, "big-1.jsonl"); writeFileSync(path, "{}\n{}\n");
		// Only `valid` carries the rounded form collect() records for this file.
		const valid = source(store, "s", path, ROUNDED, 3);
		source(store, "s", path, "0:0", 6);
		expect(store.collapseDuplicateSources()).toBe(1);
		expect(store.sources().find((row) => !row.sealed)?.id).toBe(valid);
	});
});

describe("filesystems without stable file ids", () => {
	it("keeps two transcripts of one session apart when both report ino 0", () => {
		const { store, dir } = fixture();
		const a = join(dir, "noid-a.jsonl"); const b = join(dir, "noid-b.jsonl");
		writeFileSync(a, "{}\n"); writeFileSync(b, "{}\n");
		const first = store.source("s", a);
		const second = store.source("s", b);
		expect(second.id).not.toBe(first.id);
		expect(second.path).toBe(b);
	});
	it("does not collapse them", () => {
		const { store, dir } = fixture();
		const a = join(dir, "noid-a.jsonl"); const b = join(dir, "noid-b.jsonl");
		writeFileSync(a, "{}\n"); writeFileSync(b, "{}\n");
		source(store, "s", a, "1:0", 3); source(store, "s", b, "1:0", 3);
		expect(store.collapseDuplicateSources()).toBe(0);
		expect(store.sources().every((row) => !row.sealed)).toBe(true);
	});
});
