import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/agent/store.js";
import { validateConfig } from "../src/agent/config.js";
import { collect, actorOf, shapeOf } from "../src/agent/collector.js";
import { drain } from "../src/agent/delivery.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture(overrides = {}) {
	const dir = mkdtempSync(join(tmpdir(), "loom-agent-test-"));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	const config = validateConfig({ token: "test-token", url: "http://127.0.0.1:9999", ...overrides });
	const store = new Store(dir, config); cleanup.push(() => store.close());
	const path = join(dir, "session.jsonl"); writeFileSync(path, "");
	const source = store.source("host-session", path);
	return { dir, store, config, path, source };
}
function successful(requests: Array<{ path: string; body: any }>): typeof fetch {
	return (async (url, init) => {
		const path = new URL(String(url)).pathname; const body = JSON.parse(init!.body as string);
		requests.push({ path, body });
		return Response.json(path.endsWith("/batch") ? {
			inserted: body.episodes.length, skipped: 0,
			results: body.episodes.map((ep: any, i: number) => ({ idempotency_key: ep.idempotency_key, episode_id: i + 1 })),
		} : { enqueued: true });
	}) as typeof fetch;
}

describe("full experience collection", () => {
	it("retains all raw records, unknown types and tool results, without importance filtering", () => {
		const { store, source, path } = fixture();
		const records = [
			{ type: "user", uuid: "u1", message: { role: "user", content: "Fix this" } },
			{ type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "test" } }] } },
			{ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "failed" }] } },
			{ type: "future_host_event", payload: { all: "preserved" } },
		];
		writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
		expect(collect(store, source.id)).toBe(4);
		const episodes = store.batch().map((row) => JSON.parse(row.body));
		expect(episodes.map((ep) => ep.content)).toEqual(records.map((record) => JSON.stringify(record)));
		expect(episodes.map((ep) => ep.actor_type)).toEqual(["user", "assistant", "tool", "system"]);
		expect(episodes.map((ep) => ep.type)).toEqual(["message", "tool_call", "tool_result", "capture_record"]);
		expect(collect(store, source.id)).toBe(0);
		expect(store.batch()).toHaveLength(4);
	});
	it("recognizes Codex response items without discarding other event records", () => {
		expect(actorOf({ type: "response_item", payload: { type: "function_call_output", output: "error" } })).toBe("tool");
		expect(actorOf({ type: "response_item", payload: { type: "message", role: "assistant" } })).toBe("assistant");
		expect(actorOf({ type: "event_msg", payload: { type: "future_type" } })).toBe("system");
		expect(shapeOf({ type: "response_item", payload: { type: "function_call_output", call_id: "call1", output: "error" } }))
			.toMatchObject({ type: "tool_result", metadata: { toolUseId: "call1", outcomeUnknown: true } });
		expect(shapeOf({ type: "response_item", payload: { type: "function_call_output", output: '{"exit_code":1}' } }))
			.toMatchObject({ metadata: { isError: true } });
	});
	it("does not advance past a partial UTF-8/JSONL record or finalize its segment", async () => {
		const { store, source, path } = fixture();
		writeFileSync(path, '{"type":"user","message":{"role":"user","content":"한글');
		expect(collect(store, source.id)).toBe(0);
		store.markEnded(source.session);
		const requests: any[] = []; await drain(store, successful(requests), true);
		expect(requests).toHaveLength(0);
		appendFileSync(path, '"}}\n');
		await drain(store, successful(requests), true);
		expect(requests.map((r) => r.path)).toEqual(["/ingest/episodes/batch", "/ingest/session-end"]);
	});
	it("splits large Unicode records without content loss and stays within the wire byte limit", () => {
		const { store, source, path, config } = fixture({ batchBytes: 16_384 });
		const raw = JSON.stringify({ type: "assistant", message: { role: "assistant", content: "😀한글\n\"".repeat(5000) } });
		writeFileSync(path, raw + "\n"); collect(store, source.id);
		const parts: string[] = [];
		while (store.batch().length) {
			const batch = store.batch(); const episodes = batch.map((row) => JSON.parse(row.body));
			expect(Buffer.byteLength(JSON.stringify({ episodes }))).toBeLessThanOrEqual(config.batchBytes);
			parts.push(...episodes.map((ep) => ep.content)); store.ack(batch);
		}
		expect(parts.join("")).toBe(raw);
		expect(store.get("queueBytes", -1)).toBe(0);
	});
	it("keeps the cursor behind a full outbox and retries after space is available", () => {
		const { store, source, path } = fixture();
		store.config.maxQueueBytes = 100;
		writeFileSync(path, JSON.stringify({ type: "user", content: "x".repeat(500) }) + "\n");
		expect(() => collect(store, source.id)).toThrow("queue is full");
		expect(store.sources()[0]!.offset).toBe(0);
		expect(store.batch()).toHaveLength(0);
		store.config.maxQueueBytes = 100_000;
		expect(collect(store, source.id)).toBe(1);
	});
	it("opens a new immutable ingestion segment when a closed host session resumes", async () => {
		const { store, source, path } = fixture(); const requests: any[] = [];
		writeFileSync(path, '{"type":"user","content":"first"}\n');
		collect(store, source.id); store.markEnded(source.session);
		await drain(store, successful(requests), true);
		appendFileSync(path, '{"type":"user","content":"second"}\n'); collect(store, source.id);
		expect(JSON.parse(store.batch()[0]!.body).session_id).not.toBe(requests[0].body.episodes[0].session_id);
	});
	it("detects an in-place rewrite that regrows past the previous cursor", () => {
		const { store, source, path } = fixture();
		writeFileSync(path, '{"type":"user","content":"old"}\n'); collect(store, source.id);
		writeFileSync(path, '{"type":"user","content":"new and longer"}\n'); collect(store, source.id);
		expect(store.batch().map((row) => JSON.parse(row.body).content)).toHaveLength(2);
		expect(store.batch()[1]!.body).toContain("new and longer");
	});
	it("seals a long segment at a completed-turn checkpoint even without an idle gap", () => {
		const { store, source, path } = fixture();
		writeFileSync(path, '{"type":"user","content":"event"}\n'); collect(store, source.id);
		store.db.prepare("UPDATE segments SET created_at=0").run();
		store.closeIdleSegments();
		expect(store.db.prepare("SELECT closed FROM segments").get()!.closed).toBe(0);
		store.db.prepare("UPDATE sources SET checkpoint=1").run(); store.closeIdleSegments();
		expect(store.db.prepare("SELECT closed FROM segments").get()!.closed).toBe(1);
	});
});

describe("batched delivery and overload", () => {
	it("sends 100 source records as one request, before one segmentation signal", async () => {
		const { store, source, path } = fixture(); const requests: any[] = [];
		writeFileSync(path, Array.from({ length: 100 }, (_, i) => JSON.stringify({ type: "user", content: `event ${i}` })).join("\n") + "\n");
		collect(store, source.id); store.markEnded(source.session);
		await drain(store, successful(requests), true);
		expect(requests).toHaveLength(2); expect(requests[0].body.episodes).toHaveLength(100);
		expect(store.batch()).toHaveLength(0);
		expect((store.status().metrics as any).events).toBe(100);
	});
	it("honors Retry-After and never sends segmentation while episodes are pending", async () => {
		const { store, source, path } = fixture(); let calls = 0;
		writeFileSync(path, '{"type":"user","content":"event"}\n'); store.markEnded(source.session);
		const busy = (async () => { calls++; return new Response("busy", { status: 429, headers: { "retry-after": "120" } }); }) as typeof fetch;
		await drain(store, busy, true); await drain(store, busy, true);
		expect(calls).toBe(1); expect(store.batch()).toHaveLength(1);
		expect(store.get<any>("delivery", {}).retryAt).toBeGreaterThan(Date.now() + 119_000);
	});
	it("replays the same batch keys after an ambiguous response and a process restart", async () => {
		const { store, source, path, dir, config } = fixture(); let keys: string[] = [];
		writeFileSync(path, '{"type":"assistant","content":"result"}\n'); collect(store, source.id);
		await drain(store, (async (_url, init) => {
			keys = JSON.parse(init!.body as string).episodes.map((ep: any) => ep.idempotency_key);
			throw new Error("connection lost after commit");
		}) as typeof fetch, true);
		const reopened = new Store(dir, config); cleanup.push(() => reopened.close());
		reopened.set("delivery", { retryAt: 0, failures: 0, lastSuccess: 0 });
		const requests: any[] = []; await drain(reopened, successful(requests), true);
		expect(requests[0].body.episodes.map((ep: any) => ep.idempotency_key)).toEqual(keys);
		expect(reopened.batch()).toHaveLength(0);
	});
	it("does not accept an incomplete 2xx acknowledgement as durable delivery", async () => {
		const { store, path } = fixture(); writeFileSync(path, '{"type":"user","content":"event"}\n');
		await drain(store, (async () => Response.json({ results: [] })) as typeof fetch, true);
		expect(store.batch()).toHaveLength(1);
	});
	it("allows only one in-flight uploader across concurrent sessions", async () => {
		const { store, path, config, dir } = fixture(); writeFileSync(path, '{"type":"user","content":"event"}\n');
		const other = new Store(dir, config); cleanup.push(() => other.close());
		let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
		const requests: any[] = []; const ok = successful(requests);
		const slow = (async (...args: Parameters<typeof fetch>) => { await gate; return ok(...args); }) as typeof fetch;
		const first = drain(store, slow, true); await drain(other, slow, true); release(); await first;
		expect(requests).toHaveLength(1);
	});
	it("never reads or uploads captures when collection is disabled", async () => {
		const { store, path } = fixture({ capture: false }); writeFileSync(path, '{"type":"user","content":"private"}\n');
		const requests: any[] = []; await drain(store, successful(requests), true);
		expect(requests).toHaveLength(0); expect(store.batch()).toHaveLength(0);
	});
});
