import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/agent/store.js";
import { validateConfig } from "../src/agent/config.js";
import { handleHook } from "../src/agent/hooks.js";
import { createAgentServer, deliverUsage } from "../src/agent/server.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture() {
	const home = mkdtempSync(join(tmpdir(), "loom-tools-test-")); cleanup.push(() => rmSync(home, { force: true, recursive: true }));
	const store = new Store(home, validateConfig({ token: "test-token", url: "http://127.0.0.1:9999" })); cleanup.push(() => store.close());
	const transcript = join(home, "session.jsonl"); writeFileSync(transcript, "");
	const requests: Array<{ path: string; body: any }> = [];
	const fetcher = (async (url, init) => {
		const path = new URL(String(url)).pathname; const body = JSON.parse(init!.body as string); requests.push({ path, body });
		if (path === "/retrieve") return Response.json({
			candidate_lines: ['<knowledge id="1">A past decision</knowledge>'], candidates: [{ ref: "kn:1", label: "A past decision" }],
		});
		if (path === "/retrieve/query") return Response.json({ results: [{ ref: "ep:2", snippet: "another experience" }] });
		if (path === "/retrieve/read") return Response.json({ results: [{ ref: "ep:2", content: "exact evidence" }] });
		return Response.json({ ok: true });
	}) as typeof fetch;
	const [a, b] = InMemoryTransport.createLinkedPair();
	const server = createAgentServer(store, fetcher); const client = new Client({ name: "test", version: "1" });
	await server.connect(a); await client.connect(b); cleanup.push(() => client.close());
	const input = { session_id: "session", transcript_path: transcript, hook_event_name: "UserPromptSubmit", prompt: "Help with the prior decision" };
	const response = await handleHook(store, input, fetcher);
	const context = (response.hookSpecificOutput as any).additionalContext as string;
	const receipt = context.match(/Receipt: ([\w-]+)/)![1]!;
	return { store, client, requests, fetcher, input, receipt, context };
}

describe("hook/MCP feedback loop", () => {
	it("injects a bounded context and keeps usage unknown until explicitly reported", async () => {
		const { store, requests, fetcher, input, context } = await fixture();
		expect(context).toContain("kn:1"); expect(context.length).toBeLessThan(10_000);
		await handleHook(store, { ...input, hook_event_name: "Stop" }, fetcher);
		await deliverUsage(store, fetcher);
		expect(requests.some((request) => request.path === "/ingest/picks")).toBe(false);
		expect(store.db.prepare("SELECT state FROM receipts").get()!.state).toBe("unknown");
	});
	it("records additional search/read exposure without automatically strengthening it", async () => {
		const { store, client, receipt, requests } = await fixture();
		await client.callTool({ name: "memory_search", arguments: { query: "more", receipt } });
		await client.callTool({ name: "memory_read", arguments: { refs: ["ep:2"], receipt } });
		expect(JSON.parse(store.db.prepare("SELECT offered FROM receipts WHERE id=?").get(receipt)!.offered as string)).toEqual(["kn:1", "ep:2"]);
		expect(requests.some((request) => request.path === "/ingest/picks")).toBe(false);
	});
	it("rejects refs not offered, then delivers a valid explicit report after Stop", async () => {
		const { store, client, receipt, requests, input, fetcher } = await fixture();
		const bad = await client.callTool({ name: "report_memory_use", arguments: { receipt, picked: ["kn:999"] } });
		expect(bad.isError).toBe(true);
		const good = await client.callTool({ name: "report_memory_use", arguments: { receipt, picked: ["kn:1"] } });
		expect(good.isError).toBeUndefined(); await deliverUsage(store, fetcher);
		expect(requests.some((request) => request.path === "/ingest/picks")).toBe(false);
		await handleHook(store, { ...input, hook_event_name: "Stop" }, fetcher);
		await deliverUsage(store, fetcher); await deliverUsage(store, fetcher);
		const picks = requests.filter((request) => request.path === "/ingest/picks");
		expect(picks).toHaveLength(1); expect(picks[0]!.body).toMatchObject({ picked: ["kn:1"], offered: ["kn:1"] });
	});
	it("preserves explicit empty reports separately from silence", async () => {
		const { store, client, receipt, requests, input, fetcher } = await fixture();
		await client.callTool({ name: "report_memory_use", arguments: { receipt, picked: [] } });
		await handleHook(store, { ...input, hook_event_name: "Stop" }, fetcher); await deliverUsage(store, fetcher);
		expect(requests.find((request) => request.path === "/ingest/picks")!.body.picked).toEqual([]);
	});
	it("does not retry ambiguous non-idempotent reinforcement", async () => {
		const { store, client, receipt, input, fetcher } = await fixture();
		await client.callTool({ name: "report_memory_use", arguments: { receipt, picked: ["kn:1"] } });
		await handleHook(store, { ...input, hook_event_name: "Stop" }, fetcher);
		let calls = 0; const broken = (async () => { calls++; throw new Error("lost response after commit"); }) as typeof fetch;
		await deliverUsage(store, broken); await deliverUsage(store, broken);
		expect(calls).toBe(1); expect(store.db.prepare("SELECT state FROM receipts").get()!.state).toBe("delivery_unknown");
	});
	it("drops staged usage on interruption, while leaving captured experiences alone", async () => {
		const { store, client, receipt, input, fetcher, requests } = await fixture();
		await client.callTool({ name: "report_memory_use", arguments: { receipt, picked: ["kn:1"] } });
		await handleHook(store, { ...input, hook_event_name: "Interrupt" }, fetcher);
		await handleHook(store, { ...input, hook_event_name: "Stop" }, fetcher); await deliverUsage(store, fetcher);
		expect(requests.some((request) => request.path === "/ingest/picks")).toBe(false);
	});
	it("silently preserves capture and unknown feedback across repeated recall failures", async () => {
		const { store, input, client, fetcher, requests } = await fixture();
		writeFileSync(input.transcript_path, '{"type":"user","message":{"role":"user","content":"experience"}}\n');
		for (let i = 0; i < 2; i++) {
			const result = await handleHook(store, input, (async () => { throw new Error("SECRET_TRANSPORT_CANARY"); }) as typeof fetch);
			expect(result).toEqual({});
		}
		expect(store.batch()).toHaveLength(1);
		expect(store.status().recall).toMatchObject({ status: "unavailable", failures: 2, lastError: { kind: "unavailable" } });
		const status = await client.callTool({ name: "memory_status", arguments: {} });
		expect(JSON.stringify(status)).not.toContain("SECRET_TRANSPORT_CANARY");
		await handleHook(store, { ...input, hook_event_name: "Stop" }, fetcher);
		await deliverUsage(store, fetcher);
		expect(requests.some((r) => r.path === "/ingest/picks")).toBe(false);
		expect(store.db.prepare("SELECT state FROM receipts").all()).toEqual([{ state: "unknown" }]);
	});
	it("reloads YAML notification preferences and exposes failure/recovery diagnostics", async () => {
		const { store, input, fetcher } = await fixture();
		const settings = join(store.home, "settings.yaml");
		writeFileSync(settings, "notifications:\n  recall_errors: true\n");
		const failed = await handleHook(store, input, (async () => new Response("SECRET_BODY", { status: 503 })) as typeof fetch);
		expect(failed.systemMessage).toContain("Loom recall is unavailable");
		expect(store.status().recall).toMatchObject({ status: "unavailable", lastError: { kind: "http", httpStatus: 503 } });
		expect(JSON.stringify(store.status())).not.toContain("SECRET_BODY");
		writeFileSync(settings, "notifications:\n  recall_errors: false\n");
		expect(await handleHook(store, input, (async () => { throw new DOMException("timeout", "TimeoutError"); }) as typeof fetch)).toEqual({});
		expect(store.status().recall).toMatchObject({ status: "unavailable", lastError: { kind: "timeout" } });
		const recovered = await handleHook(store, input, fetcher);
		expect(recovered.systemMessage).toBeUndefined(); expect(recovered.hookSpecificOutput).toBeDefined();
		expect(store.status().recall).toMatchObject({ status: "ok", failures: 0, lastSuccessAt: expect.any(Number), lastFailureAt: expect.any(Number) });
	});
	it.each([
		["notifications: [SECRET_YAML", "invalid_yaml"],
		['notifications:\n  recall_errors: "false"\n', "invalid_settings"],
	])("keeps a broken settings file quiet without blocking capture (%s)", async (yaml, code) => {
		const { store, input } = await fixture();
		writeFileSync(join(store.home, "settings.yaml"), yaml);
		writeFileSync(input.transcript_path, '{"type":"user","message":{"role":"user","content":"retained"}}\n');
		expect(await handleHook(store, input, (async () => Response.json({ unexpected: true })) as typeof fetch)).toEqual({});
		expect(store.status()).toMatchObject({ settingsError: code, notifications: { recall_errors: false }, recall: { lastError: { kind: "invalid_response" } } });
		expect(JSON.stringify(store.status())).not.toContain("SECRET_YAML");
		expect(store.batch()).toHaveLength(1);
	});
	it("captures a completed subagent without completing the parent's staged feedback", async () => {
		const { store, client, receipt, input, fetcher, requests } = await fixture();
		const path = `${input.transcript_path}.child`;
		const raw = JSON.stringify({ type: "assistant", message: { role: "assistant", content: "child's experience" } });
		writeFileSync(path, `${raw}\n`);
		await client.callTool({ name: "report_memory_use", arguments: { receipt, picked: ["kn:1"] } });
		await handleHook(store, { ...input, hook_event_name: "SubagentStop", agent_id: "child", agent_transcript_path: path }, fetcher);
		await deliverUsage(store, fetcher);
		expect(requests.some((request) => request.path === "/ingest/picks")).toBe(false);
		expect(store.db.prepare("SELECT state FROM receipts WHERE id=?").get(receipt)!.state).toBe("open");
		const episode = store.batch()[0]!;
		expect(JSON.parse(episode.body)).toMatchObject({ content: raw, metadata: { source_session_id: "session:agent:child" } });
		expect(store.sources().find((source) => source.session === "session:agent:child")!.ended).toBe(1);
	});
});
