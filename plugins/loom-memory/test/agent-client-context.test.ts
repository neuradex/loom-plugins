import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/agent/store.js";
import { saveConfig, validateConfig } from "../src/agent/config.js";
import { collect } from "../src/agent/collector.js";
import { drain } from "../src/agent/delivery.js";
import { clientContext } from "../src/agent/client-context.js";
import { captureHook, handleHook } from "../src/agent/hooks.js";
import { createRuntime } from "../src/agent/runtime.js";

const cleanup: Array<() => void> = [];
afterEach(() => { vi.unstubAllEnvs(); for (const fn of cleanup.splice(0).reverse()) fn(); });
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "loom-context-test-"));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}
function fixture() {
	const dir = scratch();
	const store = new Store(dir, validateConfig({ token: "test-token", url: "http://127.0.0.1:9999" }));
	cleanup.push(() => store.close());
	const path = join(dir, "session.jsonl"); writeFileSync(path, "");
	return { dir, store, path };
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
const HOME = "/Users/someone";
const ORCA_KEYS = ["ORCA_TERMINAL_HANDLE", "ORCA_BOT_TOOLS_TOKEN", "ORCA_STRUCTURED_SESSION"];
/** Isolate hook tests from the Orca session that runs the test suite. */
function orcaEnv(values: Record<string, string>): void {
	for (const key of ORCA_KEYS) vi.stubEnv(key, values[key] ?? undefined);
}

describe("clientContext", () => {
	it.each([
		["a worker started from a bot", { ORCA_TERMINAL_HANDLE: "structworker_1", ORCA_BOT_TOOLS_TOKEN: "t", ORCA_STRUCTURED_SESSION: "1" }, `${HOME}/.orca/bots/neuradex`, "orca-worker"],
		["a bot by its tools token", { ORCA_BOT_TOOLS_TOKEN: "t", ORCA_STRUCTURED_SESSION: "1" }, "/repo", "orca-bot"],
		["a bot by its working directory", {}, `${HOME}/.orca/bots/neuradex/sub`, "orca-bot"],
		["a sibling of the bots directory", {}, `${HOME}/.orca/botsX`, undefined],
		["the bots directory itself", {}, `${HOME}/.orca/bots`, undefined],
		["an Orca chat", { ORCA_STRUCTURED_SESSION: "1" }, "/repo", "orca-chat"],
		["an Orca terminal", { ORCA_TERMINAL_HANDLE: "term_1" }, "/repo", "orca-terminal"],
		["a plain terminal", {}, "/repo", undefined],
		["no working directory", {}, undefined, undefined],
	])("labels %s", (_name, env, cwd, expected) => {
		expect(clientContext(env, cwd, HOME)).toBe(expected);
	});
	it("does not put the bot token's value in the label", () => {
		expect(clientContext({ ORCA_BOT_TOOLS_TOKEN: "secret-token" }, undefined, HOME)).not.toContain("secret");
	});
});

describe("client context capture", () => {
	it("tags every queued episode of a labelled source", () => {
		const { store, path } = fixture();
		const source = store.source("s", path, "orca-bot");
		writeFileSync(path, '{"type":"user","content":"a"}\n{"type":"assistant","content":"b"}\n');
		collect(store, source.id);
		const episodes = store.batch().map((row) => JSON.parse(row.body));
		expect(episodes).toHaveLength(2);
		expect(episodes.map((ep) => ep.metadata.client_context)).toEqual(["orca-bot", "orca-bot"]);
	});
	it("labels a source that started before the label existed on its next hook, without relabelling", () => {
		const { store, path } = fixture();
		const source = store.source("s", path);
		expect(source.client_context).toBeNull();
		expect(store.source("s", path, "orca-bot").client_context).toBe("orca-bot");
		expect(store.source("s", path, "orca-chat").client_context).toBe("orca-bot");
		writeFileSync(path, '{"type":"user","content":"a"}\n'); collect(store, source.id);
		expect(JSON.parse(store.batch()[0]!.body).metadata.client_context).toBe("orca-bot");
	});
	it("omits the key for a session outside Orca", () => {
		const { store, path } = fixture();
		const source = store.source("s", path);
		writeFileSync(path, '{"type":"user","content":"a"}\n'); collect(store, source.id);
		expect(JSON.parse(store.batch()[0]!.body).metadata).not.toHaveProperty("client_context");
	});
	it("does not change idempotency keys", () => {
		const a = fixture(); const b = fixture();
		const plain = a.store.source("s", a.path); const tagged = b.store.source("s", a.path, "orca-worker");
		writeFileSync(a.path, '{"type":"user","uuid":"u1","content":"a"}\n');
		collect(a.store, plain.id); collect(b.store, tagged.id);
		expect(JSON.parse(b.store.batch()[0]!.body).idempotency_key).toBe(JSON.parse(a.store.batch()[0]!.body).idempotency_key);
	});
	it("takes the label from the hook process environment, for the session and its subagents", () => {
		const { store, path, dir } = fixture();
		orcaEnv({ ORCA_TERMINAL_HANDLE: "structworker_abc", ORCA_STRUCTURED_SESSION: "1" });
		const child = join(dir, "agent.jsonl"); writeFileSync(child, '{"type":"user","content":"sub"}\n');
		writeFileSync(path, '{"type":"user","content":"a"}\n');
		captureHook(store, { session_id: "s", cwd: dir, transcript_path: path, hook_event_name: "SubagentStop", agent_id: "x", agent_transcript_path: child });
		expect(store.sources().map((source) => source.client_context)).toEqual(["orca-worker", "orca-worker"]);
		expect(store.batch().map((row) => JSON.parse(row.body).metadata.client_context)).toEqual(["orca-worker", "orca-worker"]);
	});
});

describe("client context delivery", () => {
	it("declares the label on session-end", async () => {
		const { store, path } = fixture();
		const source = store.source("s", path, "orca-bot");
		writeFileSync(path, '{"type":"user","content":"a"}\n'); collect(store, source.id); store.markEnded("s");
		const requests: Array<{ path: string; body: any }> = []; await drain(store, successful(requests), true);
		expect(requests.map((r) => r.path)).toEqual(["/ingest/episodes/batch", "/ingest/session-end"]);
		expect(requests[1]!.body).toEqual({ session_id: source.segment, client_context: "orca-bot" });
	});
	it("sends the pre-0.4.1 session-end body for an unlabelled session", async () => {
		const { store, path } = fixture();
		const source = store.source("s", path);
		writeFileSync(path, '{"type":"user","content":"a"}\n'); collect(store, source.id); store.markEnded("s");
		const requests: Array<{ path: string; body: any }> = []; await drain(store, successful(requests), true);
		expect(requests[1]!.body).toEqual({ session_id: source.segment });
	});
	it("keeps the label when the session switches graph", async () => {
		const home = scratch(); await saveConfig({ token: "fixture" }, home);
		writeFileSync(join(home, ".loom.yml"), "graph: acme/a\n");
		const transcript = join(home, "session.jsonl"); writeFileSync(transcript, '{"type":"user","content":"a"}\n');
		const recall = (async () => Response.json({ candidate_lines: [], candidates: [] })) as typeof fetch;
		const runtime = createRuntime(home, recall); cleanup.push(() => runtime.close());
		orcaEnv({ ORCA_BOT_TOOLS_TOKEN: "t", ORCA_STRUCTURED_SESSION: "1" });
		const a = (await runtime.routing.select({ session: "switch", cwd: home })).store;
		const output = await handleHook(a, { session_id: "switch", cwd: home, transcript_path: transcript, hook_event_name: "UserPromptSubmit", prompt: "q" }, recall);
		const receipt = ((output.hookSpecificOutput as any).additionalContext as string).match(/Receipt: ([\w-]+)/)![1]!;
		await runtime.routing.switchGraph({ receipt }, "acme/b");
		const b = (await runtime.routing.select({ session: "switch" })).store;
		expect(b.sources().find((source) => source.session === "switch")?.client_context).toBe("orca-bot");
	});
});
