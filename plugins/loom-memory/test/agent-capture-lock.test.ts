import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { captureLock, STALE_HOLD_MS } from "../src/agent/capture-lock.js";
import { hookLockWaitMs, RECALL_TIMEOUT_MS } from "../src/agent/hooks.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

function home(): string {
	const dir = mkdtempSync(join(tmpdir(), "loom-capture-lock-"));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}
/** Reproduce a published lock exactly as every shipped version writes it: a
 * directory holding a bare PID. `heldForMs` ages the directory as if the owner
 * took it that long ago. */
function publishOwner(dir: string, pid: number, heldForMs = 0): string {
	const lock = join(dir, "capture.lock");
	mkdirSync(lock, { recursive: true });
	writeFileSync(join(lock, "pid"), String(pid));
	if (heldForMs) { const then = (Date.now() - heldForMs) / 1000; utimesSync(lock, then, then); }
	return lock;
}

describe("capture lock ownership", () => {
	it("evicts a live owner that has held the lock longer than any healthy collection", async () => {
		// The incident: a pre-watchdog 0.3.0 MCP process kept the lock for 12 hours
		// while idle, and every newer hook waited its full budget and was killed.
		const dir = home();
		publishOwner(dir, process.pid, STALE_HOLD_MS + 5_000);
		const started = Date.now();
		await expect(captureLock(dir, () => "ran", { waitMs: 500 })).resolves.toBe("ran");
		expect(Date.now() - started).toBeLessThan(500);
		expect(existsSync(join(dir, "capture.lock"))).toBe(false);
	});
	it("leaves a live owner inside the bound alone and gives up at the caller's budget", async () => {
		const dir = home();
		const lock = publishOwner(dir, process.pid, 1_000);
		let ran = false;
		const started = Date.now();
		await expect(captureLock(dir, () => { ran = true; }, { waitMs: 300 })).rejects.toThrow("busy");
		const elapsed = Date.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(300);
		expect(elapsed).toBeLessThan(2_000);
		expect(ran).toBe(false);
		expect(readFileSync(join(lock, "pid"), "utf8")).toBe(String(process.pid));
	});
	it("evicts a dead owner immediately regardless of age", async () => {
		const dir = home();
		const exited = spawnSync(process.execPath, ["-e", "0"]);
		publishOwner(dir, exited.pid, 0);
		const started = Date.now();
		await expect(captureLock(dir, () => "ran", { waitMs: 500 })).resolves.toBe("ran");
		expect(Date.now() - started).toBeLessThan(500);
	});
	it("does not let an evicted owner's release remove the replacement's lock", async () => {
		const dir = home();
		const lock = join(dir, "capture.lock");
		let release!: () => void;
		const first = captureLock(dir, () => new Promise<void>(done => { release = done; }));
		await expect.poll(() => existsSync(join(lock, "pid"))).toBe(true);
		const then = (Date.now() - STALE_HOLD_MS - 5_000) / 1000;
		utimesSync(lock, then, then);
		let acquired = false; let finish!: () => void;
		const second = captureLock(dir, () => { acquired = true; return new Promise<void>(done => { finish = done; }); }, { waitMs: 1_000 });
		await expect.poll(() => acquired).toBe(true);
		// The wedged owner wakes up after its eviction. Its cleanup must recognise
		// that the directory now belongs to someone else.
		release(); await first;
		expect(existsSync(lock)).toBe(true);
		finish(); await second;
		expect(existsSync(lock)).toBe(false);
	});
});

describe("hook time budget", () => {
	const hooks = JSON.parse(readFileSync(resolve("plugins/loom-memory/hooks/hooks.json"), "utf8")).hooks as
		Record<string, Array<{ hooks: Array<{ timeout: number }> }>>;
	it("keeps every hook's lock wait plus recall deadline well inside the host's hook timeout", () => {
		expect(Object.keys(hooks)).toContain("SessionEnd");
		for (const [event, entries] of Object.entries(hooks)) {
			const hostMs = entries[0]!.hooks[0]!.timeout * 1000;
			const budget = hookLockWaitMs(event) + (event === "UserPromptSubmit" ? RECALL_TIMEOUT_MS : 0);
			// Process start-up and transcript collection also need room. A budget equal
			// to the host's timeout means the host kills the hook before it can answer.
			expect(budget, `${event} budget ${budget}ms vs host ${hostMs}ms`).toBeLessThanOrEqual(hostMs * 0.75);
		}
	});
	it.each(["SessionEnd", "UserPromptSubmit"])("answers %s with a busy message before the host's timeout while a fresh live owner holds the lock", async event => {
		const dir = home();
		const bundle = join(dir, "plugin");
		await promisify(execFile)(process.execPath, [resolve("scripts/build-memory-plugin.mjs"), bundle]);
		writeFileSync(join(bundle, "package.json"), '{"type":"module"}');
		const memoryHome = join(dir, "home"); mkdirSync(memoryHome);
		writeFileSync(join(memoryHome, "config.json"), JSON.stringify({ token: "fixture-token", url: "http://127.0.0.1:1" }));
		const transcript = join(dir, "session.jsonl"); writeFileSync(transcript, "");
		publishOwner(memoryHome, process.pid, 1_000);
		const hostMs = hooks[event]![0]!.hooks[0]!.timeout * 1000;
		const started = Date.now();
		const child = spawn(process.execPath, [join(bundle, "dist/cli.js"), "hook"], { env: { PATH: process.env.PATH!, LOOM_MEMORY_HOME: memoryHome }, stdio: ["pipe", "pipe", "pipe"] });
		const output: Buffer[] = []; child.stdout.on("data", chunk => output.push(chunk)); child.stderr.resume();
		child.stdin.end(JSON.stringify({ cwd: dir, hook_event_name: event, session_id: "budget", transcript_path: transcript, prompt: "anything" }));
		expect(await new Promise<number | null>(done => child.on("exit", done))).toBe(0);
		expect(Date.now() - started).toBeLessThan(hostMs * 0.75);
		expect(JSON.parse(Buffer.concat(output).toString())).toEqual({ systemMessage: expect.stringContaining("busy") });
	}, 15_000);
});
