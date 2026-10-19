import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/agent/store.js";
import { validateConfig } from "../src/agent/config.js";
import { handleHook } from "../src/agent/hooks.js";
import { createAgentServer } from "../src/agent/server.js";
import { drain } from "../src/agent/delivery.js";
import { BOARD_TAG_OPEN, BUDGET_CHARS, closeInquiry, deliverBoard, groundingKey, openInquiry, renderBoardBlock, snapshot, toRepoRelative } from "../src/agent/board.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

interface Request { path: string; body: any }
function fixture() {
	const home = mkdtempSync(join(tmpdir(), "loom-board-test-")); cleanup.push(() => rmSync(home, { force: true, recursive: true }));
	const store = new Store(home, validateConfig({ token: "test-token", url: "http://127.0.0.1:9999" })); cleanup.push(() => store.close());
	const cwd = join(home, "repo");
	const transcript = join(home, "session.jsonl"); writeFileSync(transcript, "");
	const requests: Request[] = [];
	let nextInquiryId = 100;
	const fetcher = (async (url, init) => {
		const path = new URL(String(url)).pathname; const body = JSON.parse(init!.body as string); requests.push({ path, body });
		if (path === "/retrieve") return Response.json({ candidate_lines: ['<knowledge id="1">A past decision</knowledge>'], candidates: [{ ref: "kn:1", label: "A past decision" }] });
		if (path === "/ingest/inquiries") return Response.json({ ok: true, id: body.id ?? nextInquiryId++, indexed: body.status !== "open" });
		if (path.endsWith("/batch")) return Response.json({ results: body.episodes.map((ep: any, i: number) => ({ idempotency_key: ep.idempotency_key, episode_id: 500 + i })) });
		return Response.json({ ok: true });
	}) as typeof fetch;
	const base = { session_id: "host-session", transcript_path: transcript, cwd };
	const hook = (input: Record<string, unknown>) => handleHook(store, { ...base, ...input }, fetcher);
	return { home, store, cwd, transcript, requests, fetcher, hook };
}
async function mcp(store: Store, fetcher: typeof fetch) {
	const [a, b] = InMemoryTransport.createLinkedPair();
	const server = createAgentServer(store, fetcher); const client = new Client({ name: "test", version: "1" });
	await server.connect(a); await client.connect(b); cleanup.push(() => client.close());
	const call = async (name: string, args: Record<string, unknown>) => {
		const result = await client.callTool({ name, arguments: args });
		return { isError: result.isError, value: JSON.parse((result.content as any)[0].text) };
	};
	return call;
}

describe("working board: ledger and grounding", () => {
	it("anchors a question to the file open when it was asked and grounds the close on files touched since", async () => {
		const { store, cwd, hook } = fixture();
		await hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: join(cwd, "src", "a.ts") } });
		const item = openInquiry(store, "host-session", "Is the retry guard already applied in a.ts?");
		expect(item.id).toBe("q1"); expect(item.anchors).toEqual(["file:src/a.ts"]);
		await hook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(cwd, "src", "b.ts") } });
		await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls src" } });
		await hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/etc/hosts" } });
		const closed = closeInquiry(store, "host-session", "q1", { answer: "No — b.ts:12 wraps it, a.ts calls through." });
		expect(closed.ok && closed.item.state).toBe("resolved");
		expect(closed.ok && closed.item.grounded).toEqual(["file:src/b.ts"]);
	});
	it("uses the most recent files for a question registered after the hunt, and lets an explicit grounding win", () => {
		const { store } = fixture();
		store.db.prepare("INSERT INTO touches(session,file) VALUES (?,?),(?,?)").run("host-session", "x.ts", "host-session", "y.ts");
		const late = openInquiry(store, "host-session", "late question");
		const auto = closeInquiry(store, "host-session", late.id, { answer: "found" });
		expect(auto.ok && auto.item.grounded).toEqual(["file:y.ts", "file:x.ts"]);
		const explicit = openInquiry(store, "host-session", "another");
		const narrowed = closeInquiry(store, "host-session", explicit.id, { answer: "found", grounded: ["sym:x.ts#guard", "not an anchor", "rule:Bad Slug"] });
		expect(narrowed.ok && narrowed.item.grounded).toEqual(["sym:x.ts#guard"]);
	});
	it("refuses empty answers and double closes with a readable reason", () => {
		const { store } = fixture();
		const item = openInquiry(store, "host-session", "q");
		expect(closeInquiry(store, "host-session", item.id, { answer: "   " })).toEqual({ ok: false, reason: "empty_answer" });
		expect(closeInquiry(store, "host-session", item.id, { answer: "a", status: "abandoned" }).ok).toBe(true);
		expect(closeInquiry(store, "host-session", item.id, { answer: "b" })).toEqual({ ok: false, reason: "already_closed" });
		expect(closeInquiry(store, "host-session", "q9", { answer: "b" })).toEqual({ ok: false, reason: "not_found" });
	});
	it("keeps repo-relative paths and drops everything outside the project", () => {
		expect(toRepoRelative("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
		expect(toRepoRelative("src/a.ts", "/repo")).toBe("src/a.ts");
		expect(toRepoRelative("/elsewhere/a.ts", "/repo")).toBeNull();
		expect(toRepoRelative("/repo", "/repo")).toBeNull();
		expect(toRepoRelative(42, "/repo")).toBeNull();
	});
});

describe("working board: hook positions", () => {
	it("stays silent for a session without board state", async () => {
		const { hook } = fixture();
		for (const event of ["PreToolUse", "PostToolUse", "Stop", "SessionEnd"]) expect(await hook({ hook_event_name: event })).toEqual({});
	});
	it("appends the board after the recall cards and nudges to open once a file was touched", async () => {
		const { store, hook, cwd } = fixture();
		const before = await hook({ hook_event_name: "UserPromptSubmit", prompt: "first" });
		expect((before.hookSpecificOutput as any).additionalContext).not.toContain(BOARD_TAG_OPEN);
		await hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: join(cwd, "a.ts") } });
		const nudged = await hook({ hook_event_name: "UserPromptSubmit", prompt: "second" });
		const context = (nudged.hookSpecificOutput as any).additionalContext as string;
		expect(context.indexOf("kn:1")).toBeLessThan(context.indexOf(BOARD_TAG_OPEN));
		expect(context).toContain("inquiry_open(");
		openInquiry(store, "host-session", "Where is the guard?", "decides whether to add one");
		await hook({ hook_event_name: "PostToolUse", tool_name: "TodoWrite", tool_input: { todos: [{ content: "Add guard", status: "in_progress" }, { content: "Ship", status: "completed" }] } });
		const board = (await hook({ hook_event_name: "UserPromptSubmit", prompt: "third" }) as any).hookSpecificOutput.additionalContext as string;
		expect(board).toContain("open inquiries (1)"); expect(board).toContain("q1 Where is the guard? — decides whether to add one");
		expect(board).toContain("todo 1/2 done"); expect(board).toContain("▸ Add guard");
		expect(board).not.toContain("inquiry_open(");
	});
	it("still injects the board when recall is disabled", async () => {
		const { store, fetcher } = fixture();
		store.config.recall = false;
		openInquiry(store, "host-session", "q");
		const output = await handleHook(store, { session_id: "host-session", hook_event_name: "UserPromptSubmit", prompt: "x" }, fetcher);
		expect((output.hookSpecificOutput as any).additionalContext).toContain(BOARD_TAG_OPEN);
	});
	it("forces one follow-up turn for a hunted question, then lets the turn end", async () => {
		const { store, hook, cwd } = fixture();
		const hunted = openInquiry(store, "host-session", "hunted question");
		expect(await hook({ hook_event_name: "Stop" })).toEqual({});
		await hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: join(cwd, "a.ts") } });
		// Opened after the last touch: nothing was hunted for it yet, so it may stay open.
		openInquiry(store, "host-session", "untouched question");
		const blocked = await hook({ hook_event_name: "Stop" });
		expect(blocked.decision).toBe("block"); expect(String(blocked.reason)).toContain(`${hunted.id} "hunted question"`);
		expect(String(blocked.reason)).not.toContain("untouched question");
		expect(await hook({ hook_event_name: "Stop", stop_hook_active: true })).toEqual({});
		expect(await hook({ hook_event_name: "Stop" })).toEqual({});
	});
	it("renders within budget and reports what it dropped", () => {
		const inquiries = Array.from({ length: 40 }, (_, i) => ({ id: `q${i}`, title: `question ${i} ${"x".repeat(100)}`, state: "open" as const }));
		const block = renderBoardBlock({ todos: [], inquiries: inquiries as any })!;
		expect(block.length).toBeLessThan(BUDGET_CHARS + 400); expect(block).toMatch(/\(\+\d+ more — inquiry_list\)/);
		expect(renderBoardBlock({ todos: [], inquiries: [] })).toBeNull();
	});
});

describe("working board: landing", () => {
	it("lands an open question once, updates the same row on close, and cites the acknowledged user message", async () => {
		const { store, hook, requests, fetcher, transcript } = fixture();
		writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "u1", timestamp: new Date(Date.now() - 5000).toISOString(), message: { role: "user", content: "Fix the guard" } }) + "\n");
		await hook({ hook_event_name: "UserPromptSubmit", prompt: "Fix the guard" });
		const item = openInquiry(store, "host-session", "Is there a guard?", "decides the fix");
		await deliverBoard(store, fetcher);
		expect(requests.filter((request) => request.path === "/ingest/inquiries")).toHaveLength(0);
		await drain(store, fetcher, true);
		expect(store.get(groundingKey("host-session"), null)).toMatchObject({ id: 500 });
		await deliverBoard(store, fetcher);
		const opened = requests.filter((request) => request.path === "/ingest/inquiries");
		expect(opened).toHaveLength(1);
		expect(opened[0]!.body).toMatchObject({ question: "Is there a guard?", why: "decides the fix", status: "open", grounded_by: [500] });
		expect(opened[0]!.body.id).toBeUndefined();
		expect(snapshot(store, "host-session").inquiries[0]).toMatchObject({ ref: 100, landed: "open" });
		await deliverBoard(store, fetcher);
		expect(requests.filter((request) => request.path === "/ingest/inquiries")).toHaveLength(1);
		closeInquiry(store, "host-session", item.id, { answer: "Yes, guard.ts:3", grounded: ["file:guard.ts"] });
		await deliverBoard(store, fetcher);
		const closed = requests.filter((request) => request.path === "/ingest/inquiries")[1]!.body;
		expect(closed).toMatchObject({ id: 100, status: "resolved", answer: "Yes, guard.ts:3", anchors: ["file:guard.ts"], grounded_by: [500] });
		expect(closed.idempotency_key).not.toBe(opened[0]!.body.idempotency_key);
		expect(snapshot(store, "host-session").inquiries[0]).toMatchObject({ landed: "resolved" });
	});
	it("sends an unlanded close as one closed row, waits at most a minute for grounding, and stops retrying a rejected row", async () => {
		const { store, fetcher, requests } = fixture();
		const item = openInquiry(store, "host-session", "q");
		closeInquiry(store, "host-session", item.id, { answer: "a" });
		// Episodes still queued for this session: wait, unless the question is older than the grounding window.
		const source = store.source("host-session", join(store.home, "t.jsonl"));
		store.transaction(() => store.append(source, { idempotency_key: "k1", actor_type: "user", type: "message", content: "x", metadata: {} }));
		await deliverBoard(store, fetcher);
		expect(requests.filter((request) => request.path === "/ingest/inquiries")).toHaveLength(0);
		store.db.prepare("UPDATE inquiries SET opened_at=opened_at-120000, closed_at=closed_at-120000").run();
		await deliverBoard(store, fetcher);
		const sent = requests.filter((request) => request.path === "/ingest/inquiries");
		expect(sent).toHaveLength(1); expect(sent[0]!.body).toMatchObject({ status: "resolved", answer: "a" });
		expect(sent[0]!.body.id).toBeUndefined(); expect(sent[0]!.body.grounded_by).toBeUndefined();
		const rejecting = (async (url, init) => new URL(String(url)).pathname === "/ingest/inquiries" ? new Response("{}", { status: 400 }) : fetcher(url, init)) as typeof fetch;
		const bad = openInquiry(store, "host-session", "rejected");
		store.db.prepare("UPDATE inquiries SET opened_at=opened_at-120000 WHERE id=?").run(bad.id);
		await deliverBoard(store, rejecting);
		expect(snapshot(store, "host-session").inquiries.find((row) => row.id === bad.id)).toMatchObject({ landed: "", landing_error: "Memory API HTTP 400" });
		await deliverBoard(store, fetcher);
		expect(requests.filter((request) => request.path === "/ingest/inquiries")).toHaveLength(1);
	});
	it("backs off instead of hammering when the graph is unavailable", async () => {
		const { store, fetcher, requests } = fixture();
		openInquiry(store, "host-session", "q");
		const failing = (async (url, init) => new URL(String(url)).pathname === "/ingest/inquiries" ? new Response("", { status: 503 }) : fetcher(url, init)) as typeof fetch;
		await deliverBoard(store, failing);
		expect(store.get("boardRetryAt", 0)).toBeGreaterThan(Date.now());
		await deliverBoard(store, fetcher);
		expect(requests.filter((request) => request.path === "/ingest/inquiries")).toHaveLength(0);
	});
});

describe("working board: MCP tools", () => {
	it("opens and closes through the receipt's session and lists the board", async () => {
		const { store, hook, fetcher, cwd } = fixture();
		const prompt = await hook({ hook_event_name: "UserPromptSubmit", prompt: "work" });
		const receipt = String((prompt.hookSpecificOutput as any).additionalContext).match(/Receipt: ([\w-]+)/)![1]!;
		const call = await mcp(store, fetcher);
		await hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: join(cwd, "a.ts") } });
		const opened = await call("inquiry_open", { question: "Does a.ts guard?", receipt });
		expect(opened.isError).toBeUndefined(); expect(opened.value).toMatchObject({ id: "q1", anchors: ["file:a.ts"] });
		const missing = await call("inquiry_close", { id: "q7", answer: "x", receipt });
		expect(missing.isError).toBe(true); expect(missing.value.error).toContain('Open right now: "q1"');
		const closed = await call("inquiry_close", { id: "q1", answer: "Yes, a.ts:1", receipt });
		expect(closed.value).toMatchObject({ state: "resolved", grounded: ["file:a.ts"], delivery: "queued_to_graph" });
		const board = await call("inquiry_list", { receipt });
		expect(board.value.inquiries).toEqual([expect.objectContaining({ id: "q1", state: "resolved", answer: "Yes, a.ts:1", ref: null, landed: false })]);
	});
	it("without a receipt, uses the only active session and refuses to guess between two", async () => {
		const { store, fetcher } = fixture();
		const call = await mcp(store, fetcher);
		expect((await call("inquiry_open", { question: "q" })).isError).toBe(true);
		store.db.prepare("INSERT INTO touches(session,file) VALUES (?,?)").run("only-session", "a.ts");
		expect((await call("inquiry_open", { question: "q" })).value).toMatchObject({ id: "q1" });
		expect(snapshot(store, "only-session").inquiries).toHaveLength(1);
		store.db.prepare("INSERT INTO touches(session,file) VALUES (?,?)").run("other-session", "b.ts");
		expect((await call("inquiry_open", { question: "q" })).isError).toBe(true);
	});
});
