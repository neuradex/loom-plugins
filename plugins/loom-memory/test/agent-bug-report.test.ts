import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/agent/store.js";
import { validateConfig, saveConfig } from "../src/agent/config.js";
import { createAgentServer } from "../src/agent/server.js";
import { createRuntime } from "../src/agent/runtime.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const accepted = { ok: true, id: "11111111-1111-4111-8111-111111111111", created_at: "2026-10-01T00:00:00.000Z" };
async function fixture(response: () => Promise<Response> = async () => Response.json(accepted, { status: 201 })) {
	const home = mkdtempSync(join(tmpdir(), "loom-bug-test-")); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
	const config = validateConfig({ token: "enrolled-secret-token", url: "http://127.0.0.1:9999", graph: "acme/dev" });
	const store = new Store(home, config); cleanup.push(() => store.close());
	const path = join(home, "session.jsonl"); writeFileSync(path, '{"type":"assistant","content":"original </think> tool failure"}\n');
	store.source("session", path);
	const other = join(home, "other.jsonl"); writeFileSync(other, '{"content":"OTHER_SESSION_CANARY"}\n'); store.source("other", other);
	const receipt = randomUUID();
	store.db.prepare("INSERT INTO receipts(id,session,context,offered) VALUES (?, 'session', 'test', '[]')").run(receipt);
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fetcher = (async (url, init) => { calls.push({ url: String(url), init: init! }); return response(); }) as typeof fetch;
	const client = await connect(createAgentServer(store, fetcher));
	const prepare = (args: Record<string, unknown> = {}) => client.callTool({ name: "prepare_bug_report", arguments: { title: "Tool failure", body: "Expected success; got receipt error", receipt, ...args } });
	const submit = (draft_id: string) => client.callTool({ name: "submit_bug_report", arguments: { draft_id, receipt } });
	return { store, path, client, prepare, submit, calls, receipt, home, config, fetcher };
}
async function connect(server: ReturnType<typeof createAgentServer>) {
	const [a, b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: "bug-test", version: "1" });
	await server.connect(a); await client.connect(b); cleanup.push(() => client.close()); return client;
}
const data = (result: any) => JSON.parse(result.content[0].text);

describe("MCP bug reports", () => {
	it("prepares locally without transcripts by default and freezes diagnostics", async () => {
		const f = await fixture(); const prepared = data(await f.prepare());
		expect(f.calls).toEqual([]);
		expect(prepared.preview).toMatchObject({ title: "Tool failure", session_id: "session", diagnostics: { client: "loom-memory-plugin", graph: "acme/dev" } });
		expect(prepared.attachment).toMatchObject({ included: false, lines: 0 });
		expect(JSON.stringify(prepared)).not.toContain(f.config.token);
		f.store.set("recall", { status: "changed-after-preview" });
		expect(data(await f.submit(prepared.draft_id))).toEqual(accepted);
		expect(f.calls).toHaveLength(1);
		expect(f.calls[0]!.url).toBe("http://127.0.0.1:9999/bug-reports");
		expect(JSON.parse(f.calls[0]!.init.body as string)).toEqual({ ...prepared.preview, transcript: null });
		expect(f.calls[0]!.init).toMatchObject({ redirect: "error", headers: { authorization: "Bearer enrolled-secret-token" } });
	});
	it("attaches only the selected session, preserves evidence, and redacts credentials before storage", async () => {
		const f = await fixture();
		const key = "sk-" + "a".repeat(30);
		writeFileSync(f.path, JSON.stringify({ content: `</think> ${key} ${f.config.token} Bearer other-token-value-long`, type: "tool_result" }) + "\n");
		const prepared = data(await f.prepare({ include_transcript: true, body: `Failure ${key}` }));
		expect(prepared.redactions).toBeGreaterThanOrEqual(4);
		expect(prepared.attachment).toMatchObject({ included: true, lines: 1, truncated: false });
		const draft = f.store.db.prepare("SELECT payload FROM bug_report_drafts WHERE id=?").get(prepared.draft_id)!.payload as string;
		for (const secret of [key, f.config.token, "other-token-value-long", "OTHER_SESSION_CANARY"]) expect(draft).not.toContain(secret);
		expect(JSON.parse(draft).transcript).toContain("</think>");
		writeFileSync(f.path, '{"content":"appended after preview"}\n');
		await f.submit(prepared.draft_id);
		expect(f.calls[0]!.init.body).toBe(draft);
	});
	it("bounds UTF-8 attachments and keeps complete recent records", async () => {
		const f = await fixture();
		writeFileSync(f.path, (JSON.stringify({ content: "한".repeat(1000) }) + "\n").repeat(700) + '{"content":"latest"}\n{"partial":');
		const p = data(await f.prepare({ include_transcript: true }));
		expect(p.attachment.truncated).toBe(true); expect(p.attachment.bytes).toBeLessThanOrEqual(1536 * 1024);
		await f.submit(p.draft_id);
		const payload = JSON.parse(f.calls[0]!.init.body as string);
		const lines = payload.transcript.split("\n");
		expect(lines.map((line: string) => JSON.parse(line)).at(-1)).toEqual({ content: "latest" });
		expect(payload.transcript_lines).toBe(lines.length);
		expect(Buffer.byteLength(payload.transcript)).toBe(p.attachment.bytes);
	});
	it("rejects ambiguous or mismatched session selection and invalid input before sending", async () => {
		const f = await fixture();
		for (const args of [{ receipt: undefined, include_transcript: true }, { session_id: "other", include_transcript: true }, { receipt: randomUUID() }, { title: " " }, { body: "x".repeat(20001) }]) {
			expect((await f.prepare(args)).isError).toBe(true);
		}
		expect(f.calls).toEqual([]);
	});
	it("returns the same accepted ID after restart without a second POST", async () => {
		const f = await fixture(); const p = data(await f.prepare()); await f.submit(p.draft_id);
		const reopened = new Store(f.home, f.config); cleanup.push(() => reopened.close());
		const client = await connect(createAgentServer(reopened, f.fetcher));
		expect(data(await client.callTool({ name: "submit_bug_report", arguments: { draft_id: p.draft_id } }))).toEqual(accepted);
		expect(f.calls).toHaveLength(1);
	});
	it.each(["network", "malformed", "server"])("does not retry uncertain delivery (%s)", async kind => {
		const f = await fixture(async () => { if (kind === "network") throw new Error("SECRET_TRANSPORT_CANARY"); return kind === "server" ? new Response("private server body", { status: 503 }) : Response.json({ ok: true }); });
		const p = data(await f.prepare());
		for (let i = 0; i < 2; i++) { const result = await f.submit(p.draft_id); expect(result.isError).toBe(true); expect(data(result).error).toBe("delivery_unknown"); expect(JSON.stringify(result)).not.toContain("CANARY"); }
		expect(f.calls).toHaveLength(1);
	});
	it.each([401, 403, 413, 429])("retains explicitly rejected drafts for a deliberate retry (%s)", async status => {
		let attempts = 0; const f = await fixture(async () => ++attempts === 1 ? new Response("SECRET_BODY", { status }) : Response.json(accepted));
		const p = data(await f.prepare()); const failed = await f.submit(p.draft_id);
		expect(failed.isError).toBe(true); expect(data(failed).status).toBe(status); expect(JSON.stringify(failed)).not.toContain("SECRET_BODY");
		expect(data(await f.submit(p.draft_id))).toEqual(accepted);
	});
	it("claims a draft across concurrent calls and rejects expired/missing drafts", async () => {
		const f = await fixture(); const p = data(await f.prepare());
		await Promise.all([f.submit(p.draft_id), f.submit(p.draft_id)]); expect(f.calls).toHaveLength(1);
		expect((await f.submit(randomUUID())).isError).toBe(true);
		f.store.db.prepare("UPDATE bug_report_drafts SET expires=0").run(); expect((await f.submit(p.draft_id)).isError).toBe(true);
	});
	it("routes via the receipt across turns, retaining the draft's original graph", async () => {
		const f = await fixture(); await saveConfig(f.config, f.home);
		const runtime = createRuntime(f.home, f.fetcher); cleanup.push(() => runtime.close());
		const client = await connect(runtime.server);
		const p = data(await client.callTool({ name: "prepare_bug_report", arguments: { title: "issue", body: "details", receipt: f.receipt } }));
		f.store.db.prepare("UPDATE receipts SET state='unknown' WHERE id=?").run(f.receipt);
		const result = await client.callTool({ name: "submit_bug_report", arguments: { draft_id: p.draft_id, receipt: f.receipt } });
		expect(result.isError).toBeUndefined(); expect(JSON.parse(f.calls[0]!.init.body as string).diagnostics.graph).toBe("acme/dev");
	});
});
