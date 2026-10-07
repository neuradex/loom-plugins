import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { Store } from "../src/agent/store.js";
import { validateConfig } from "../src/agent/config.js";
import { readSettings } from "../src/agent/settings.js";
import { SERVER_INSTRUCTIONS, USAGE_GUIDANCE } from "../src/agent/hooks.js";
import { sessionOrientation } from "../src/agent/orientation.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const HOUR = 3_600_000;
function fixture(graph?: string) {
	const home = mkdtempSync(join(tmpdir(), "loom-orientation-")); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
	const store = new Store(home, validateConfig({ token: "t", url: "http://127.0.0.1:9999", ...(graph ? { graph } : {}) })); cleanup.push(() => store.close());
	return { home, store };
}

describe("what the model is told automatically", () => {
	it("introduces both servers, the capture→recall loop and the graph tools in the MCP instructions", () => {
		for (const needle of ["loom-memory", "`loom`", "memory_read", "report_memory_use", "list_graphs", "switch_graph", "create_graph", "memory_status", ".loom.yml", "hooks"]) {
			expect(SERVER_INSTRUCTIONS, needle).toContain(needle);
		}
		expect(SERVER_INSTRUCTIONS).toContain(USAGE_GUIDANCE);
		expect(SERVER_INSTRUCTIONS.length).toBeLessThan(1_600);
	});
	it("ships slash commands for the graph tasks people used to do in Loom CLI", () => {
		const dir = resolve("plugins/loom-memory/commands");
		expect(readdirSync(dir).sort()).toEqual(["create.md", "graph.md", "switch.md"]);
		for (const [file, needles] of [
			["graph.md", ["memory_status", "list_graphs", "/loom-memory:switch"]],
			["switch.md", ["$ARGUMENTS", "list_graphs", "switch_graph", ".loom.yml", "personal"]],
			["create.md", ["$ARGUMENTS", "list_graph_organizations", "create_graph", "switch"]],
		] as const) {
			const text = readFileSync(join(dir, file), "utf8");
			expect(text, file).toMatch(/^---\ndescription: .+\n/);
			for (const needle of needles) expect(text, `${file} mentions ${needle}`).toContain(needle);
		}
	});
});

describe("session start orientation", () => {
	it("tells the model the graph, capture state and how recall works, and gives the person one line", () => {
		const { store } = fixture("acme/frontend");
		const now = Date.now();
		store.source("s-recent", "/t/a.jsonl"); store.source("s-recent:agent:x", "/t/a-child.jsonl");
		store.source("s-old", "/t/b.jsonl");
		store.db.prepare("UPDATE sources SET last_seen=? WHERE session LIKE 's-recent%'").run(now - HOUR);
		store.db.prepare("UPDATE sources SET last_seen=? WHERE session='s-old'").run(now - 30 * HOUR);
		store.set("delivery", { retryAt: 0, failures: 0, lastSuccess: now - 12 * 60_000 });
		store.set("recall", { status: "ok", failures: 0, lastSuccessAt: now - 90_000 });
		const result = sessionOrientation(store, { cwd: "/w", file: "/w/.loom.yml", graph: "acme/frontend" }, { notifications: { recall_errors: false, session_start: true } }, now);
		expect(result.systemMessage).toBe("Loom → acme/frontend (.loom.yml) · last 24h: 1 session captured · last upload 12 min ago · queue 0 · recall ok (1 min ago)");
		for (const needle of ["acme/frontend", "/w/.loom.yml", "1 session", "memory_read", "report_memory_use", "switch_graph", "/loom-memory:graph", "`loom`"]) {
			expect(result.additionalContext, needle).toContain(needle);
		}
		expect(result.additionalContext).not.toContain("\n\n\n");
	});
	it("reports a recall outage and a pending queue plainly, and never claims an upload that has not happened", () => {
		const { store } = fixture();
		const now = Date.now();
		const source = store.source("s", "/t/a.jsonl");
		store.transaction(() => store.append(source, { idempotency_key: "k1", actor_type: "user", type: "message", content: "x", metadata: {} }));
		store.set("recall", { status: "unavailable", failures: 3, lastFailureAt: now - 2 * HOUR, lastError: { kind: "timeout" } });
		const result = sessionOrientation(store, undefined, { notifications: { recall_errors: false, session_start: true } }, now);
		expect(result.systemMessage).toBe("Loom → personal · last 24h: 1 session captured · no upload yet · queue 1 · recall unavailable since 2 h ago (timeout)");
		expect(result.additionalContext).toContain("no .loom.yml");
	});
	it("can be silenced for the person while the model still gets its orientation", () => {
		const { store } = fixture();
		const result = sessionOrientation(store, undefined, { notifications: { recall_errors: false, session_start: false } }, Date.now());
		expect(result.systemMessage).toBeUndefined();
		expect(result.additionalContext).toContain("personal");
	});
	it("reads notifications.session_start from .loom.yml / settings.yaml with the old key still accepted", () => {
		const { home } = fixture();
		expect(readSettings(home).notifications).toEqual({ recall_errors: false, session_start: true });
		writeFileSync(join(home, "settings.yaml"), "notifications:\n  recall_errors: true\n");
		expect(readSettings(home).notifications).toEqual({ recall_errors: true, session_start: true });
		writeFileSync(join(home, "settings.yaml"), "notifications:\n  session_start: false\n");
		expect(readSettings(home).notifications).toEqual({ recall_errors: false, session_start: false });
	});
	it("is emitted by the shipped hook on SessionStart when connected", async () => {
		const dir = mkdtempSync(join(tmpdir(), "loom-orientation-bundle-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
		const bundle = join(dir, "plugin");
		await promisify(execFile)(process.execPath, [resolve("scripts/build-memory-plugin.mjs"), bundle]);
		writeFileSync(join(bundle, "package.json"), '{"type":"module"}');
		const home = join(dir, "home"); writeFileSync(join(dir, ".loom.yml"), "graph: acme/bundle\n");
		await promisify(execFile)("mkdir", ["-p", home]);
		writeFileSync(join(home, "config.json"), JSON.stringify({ token: "fixture-token", url: "http://127.0.0.1:1", capture: false }));
		const child = spawn(process.execPath, [join(bundle, "dist/cli.js"), "hook"], { env: { PATH: process.env.PATH!, LOOM_MEMORY_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
		const out: Buffer[] = []; child.stdout.on("data", chunk => out.push(chunk)); child.stderr.resume();
		child.stdin.end(JSON.stringify({ cwd: dir, hook_event_name: "SessionStart", session_id: "orient", source: "startup" }));
		expect(await new Promise<number | null>(done => child.on("exit", done))).toBe(0);
		const output = JSON.parse(Buffer.concat(out).toString());
		expect(output.systemMessage).toMatch(/^Loom → acme\/bundle \(\.loom\.yml\) · /);
		expect(output.hookSpecificOutput).toMatchObject({ hookEventName: "SessionStart" });
		expect(output.hookSpecificOutput.additionalContext).toContain("acme/bundle");
	}, 20_000);
});
