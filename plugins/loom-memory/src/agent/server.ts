import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, CredentialUnavailableError, DeliveryError } from "./delivery.js";
import { Store } from "./store.js";
import { digest } from "./config.js";
import type { Scope } from "./routing.js";
import { accessToken } from "./auth.js";
import { SERVER_INSTRUCTIONS } from "./hooks.js";
import { createMemoryClient } from "../memory.js";
import { registerBugReportTools } from "./bug-report.js";
import { closeInquiry, openInquiry, openInquiries, snapshot } from "./board.js";

const ref = z.string().regex(/^(kn|tp|ep):\d+$/);
const receiptArg = z.string().uuid().optional().describe("Receipt from the current Loom hook context. Omit only when hooks are unavailable.");
const cwdArg = z.string().optional().describe("Absolute project directory for .loom.yml lookup when no current-turn receipt is available.");
interface Receipt { id: string; session: string; context: string; offered: string; picked: string | null; state: string }

function active(store: Store, id: string): Receipt {
	const receipt = store.db.prepare("SELECT * FROM receipts WHERE id=?").get(id) as unknown as Receipt | undefined;
	if (!receipt || receipt.state !== "open") throw new Error("This receipt is not active. Use the receipt from the current turn's Loom context.");
	return receipt;
}
/** Board tools act on one host session. The receipt is the bridge from an MCP call
 * to that session; without one, the session that last touched a file or opened a
 * question in this graph is the only honest guess, and two candidates are none. */
function boardSession(store: Store, receipt: string | undefined): string {
	if (receipt) {
		const row = store.db.prepare("SELECT session FROM receipts WHERE id=?").get(receipt);
		if (!row) throw new Error("This Loom receipt was not found in the current account.");
		return String(row.session);
	}
	const recent = store.db.prepare(`SELECT session, MAX(at) at FROM (
	 SELECT session, at FROM touches UNION ALL SELECT session, opened_at at FROM inquiries) GROUP BY session ORDER BY at DESC LIMIT 2`).all();
	if (recent.length !== 1) throw new Error("Pass the current turn's receipt so the inquiry joins this session's board.");
	return String(recent[0]!.session);
}
function expose(store: Store, id: string | undefined, refs: string[]): void {
	if (!id) return;
	store.transaction(() => {
		const receipt = active(store, id);
		if (receipt.picked !== null) throw new Error("Usage was already reported. Finish this turn before adding more memories to that receipt.");
		store.db.prepare("UPDATE receipts SET offered=? WHERE id=?")
			.run(JSON.stringify([...new Set([...JSON.parse(receipt.offered) as string[], ...refs])]), id);
	});
}

export function createAgentServer(source: Store | ((scope?: Scope) => Promise<Store>), fetcher = fetch, status?: (scope?: Scope) => Promise<unknown>): McpServer {
	const server = new McpServer({ name: "loom-memory", version: "0.5.0" }, { instructions: SERVER_INSTRUCTIONS });
	const getStore = async (scope: Scope) => typeof source === "function" ? source(scope) : source;
	registerBugReportTools(server, getStore, fetcher);
	const memoryFor = (store: Store) => createMemoryClient(store.config.url, { fetch: fetcher });
	const authFor = async (store: Store) => ({ token: await accessToken(store.home, store.config, fetcher), graph: store.config.graph });
	const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
	const run = async (fn: (store: Store) => Promise<unknown> | unknown, scope: Scope = {}) => {
		try { return json(await fn(await getStore(scope))); }
		catch (error) { return { ...json({ error: error instanceof Error && !["ZodError", "SyntaxError"].includes(error.name) ? error.message : "Invalid Loom configuration or response." }), isError: true }; }
	};
	server.registerTool("memory_search", {
		description: "Search past experiences, decisions and knowledge in Loom. A result being read is not proof it was used.",
		inputSchema: { query: z.string().min(1), receipt: receiptArg, cwd: cwdArg, limit: z.number().int().min(1).max(50).default(10) },
		annotations: { readOnlyHint: true },
	}, async ({ query, receipt, cwd, limit }) => run(async (store) => {
		if (receipt) active(store, receipt);
		const result = await memoryFor(store).query(await authFor(store), { text: query, limit });
		expose(store, receipt, result.results.map((hit) => hit.ref)); return result;
	}, { receipt, cwd }));
	server.registerTool("memory_read", {
		description: "Read exact stored evidence using refs returned by recall or memory_search.",
		inputSchema: { refs: z.array(ref).min(1).max(5), receipt: receiptArg, cwd: cwdArg }, annotations: { readOnlyHint: true },
	}, async ({ refs, receipt, cwd }) => run(async (store) => {
		if (receipt) active(store, receipt);
		const result = await memoryFor(store).read(await authFor(store), { refs, max_chars_per_item: 8000 });
		expose(store, receipt, result.results.map((hit) => hit.ref)); return result;
	}, { receipt, cwd }));
	server.registerTool("remember", {
		description: "Save a durable fact the user explicitly wants remembered. Search first. This writes user-sourced knowledge; do not use it for your own guesses. Experiences are captured automatically.",
		inputSchema: { content: z.string().min(1), title: z.string().optional(), receipt: receiptArg, cwd: cwdArg }, annotations: { readOnlyHint: false, destructiveHint: false },
	}, async ({ content, title, receipt, cwd }) => run(async (store) => memoryFor(store).remember(await authFor(store), { content, title }), { receipt, cwd }));
	server.registerTool("report_memory_use", {
		description: "Report the complete set of offered memories actually used on this turn, just before finishing. Empty means explicitly none. Only a completed turn sends feedback; a missing report stays unknown.",
		inputSchema: { receipt: z.string().uuid(), picked: z.array(ref).max(64) }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
	}, async ({ receipt: id, picked }) => run((store) => store.transaction(() => {
		const receipt = active(store, id);
		const offered = new Set(JSON.parse(receipt.offered) as string[]);
		if (picked.some((item) => !offered.has(item))) throw new Error("Report contains a memory not offered on this receipt. Read/search it with this receipt first.");
		const encoded = JSON.stringify([...new Set(picked)].sort());
		if (receipt.picked !== null && receipt.picked !== encoded) throw new Error("A different report was already recorded for this turn.");
		store.db.prepare("UPDATE receipts SET picked=? WHERE id=?").run(encoded, id);
		return { recorded: true, delivery: "after_turn_completion" };
	}), { receipt: id }));
	// Tool descriptions beat the system prompt: they are read right before the call.
	// Keep them in step with SERVER_INSTRUCTIONS; a stricter threshold here alone
	// reproduced zero calls in Loom CLI even after the prompt was fixed.
	server.registerTool("inquiry_open", {
		description: "Register a question whose answer will take a hunt — a grep, several files, tracing a call path. Open it before you start digging, or the moment you notice you are already digging; if you only realize afterwards, open it then and close it right away with what you found. You are expected to answer it yourself. Closed questions are written to the graph and come back to later sessions, so the next one skips your hunt.",
		inputSchema: { question: z.string().min(1).max(2000).describe("The question, one self-contained sentence"), why: z.string().max(2000).optional().describe("What it would decide / what you would do differently (optional)"), receipt: receiptArg, cwd: cwdArg },
		annotations: { readOnlyHint: false, destructiveHint: false },
	}, async ({ question, why, receipt, cwd }) => run((store) => {
		const item = openInquiry(store, boardSession(store, receipt), question, why);
		return { id: item.id, title: item.title, anchors: item.anchors, next: `Close it with inquiry_close("${item.id}", answer, grounded) the moment you learn the answer.` };
	}, { receipt, cwd }));
	server.registerTool("inquiry_close", {
		description: "Close an open question with what you learned, the moment you learn it. Write the answer for someone who has the question and nothing else — put the path, symbol, or value in it. The files you opened are recorded automatically; pass grounded only to narrow it to what actually settled the question. Use status 'abandoned' if you could not settle it and say what you ruled out.",
		inputSchema: {
			id: z.string().min(1).describe("The inquiry id, e.g. q2"), answer: z.string().min(1).max(32_000).describe("What you learned, self-contained"),
			grounded: z.array(z.string().min(1)).max(16).optional().describe("Optional anchors that settled it, e.g. file:<repo path> or sym:<repo path>#<symbol>"),
			status: z.enum(["resolved", "abandoned"]).optional(), receipt: receiptArg, cwd: cwdArg,
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
	}, async ({ id, answer, grounded, status, receipt, cwd }) => run((store) => {
		const session = boardSession(store, receipt);
		const result = closeInquiry(store, session, id, { answer, grounded, status });
		if (!result.ok) {
			const open = openInquiries(store, session).map((item) => `"${item.id}" (${item.title.slice(0, 50)})`).join(", ");
			throw new Error(`inquiry_close failed: ${result.reason}. Open right now: ${open || "(none)"}.${result.reason === "empty_answer" ? " An empty answer erases the question instead of closing it." : ""}`);
		}
		return { id: result.item.id, state: result.item.state, grounded: result.item.grounded, delivery: "queued_to_graph" };
	}, { receipt, cwd }));
	server.registerTool("inquiry_list", {
		description: "Show this session's working board: open and closed inquiries with their grounding and graph refs, and the mirrored task list.",
		inputSchema: { receipt: receiptArg, cwd: cwdArg }, annotations: { readOnlyHint: true },
	}, async ({ receipt, cwd }) => run((store) => {
		const board = snapshot(store, boardSession(store, receipt));
		return { todos: board.todos, inquiries: board.inquiries.map((item) => ({
			id: item.id, state: item.state, title: item.title, why: item.why, answer: item.answer, grounded: item.grounded,
			ref: item.ref ? `kn:${item.ref}` : null, landed: item.landed === item.state, ...(item.landing_error ? { landing_error: item.landing_error } : {}),
		})) };
	}, { receipt, cwd }));
	server.registerTool("memory_status", {
		description: "Show capture backlog, blocked sources and delivery state without exposing credentials or conversation content.",
		inputSchema: { receipt: receiptArg, cwd: cwdArg }, annotations: { readOnlyHint: true },
	}, async ({ receipt, cwd }) => {
		if (!status) return run((store) => store.status());
		try { return json(await status({ receipt, cwd })); }
		catch { return { ...json({ error: "Loom status is temporarily unavailable. Existing queues are retained." }), isError: true }; }
	});
	return server;
}

/** Picks are not idempotent on the server. An ambiguous HTTP outcome is retained
 * as unknown, never blindly retried into duplicate reinforcement. */
export async function deliverUsage(store: Store, fetcher = fetch): Promise<void> {
	if (store.get("usageRetryAt", 0) > Date.now()) return;
	const receipt = store.transaction(() => {
		const row = store.db.prepare("SELECT * FROM receipts WHERE state='ready' LIMIT 1").get() as unknown as Receipt | undefined;
		if (row) store.db.prepare("UPDATE receipts SET state='attempted' WHERE id=?").run(row.id);
		return row;
	});
	if (!receipt) return;
	if ((JSON.parse(receipt.offered) as string[]).length === 0) {
		store.db.prepare("UPDATE receipts SET state='no_candidates' WHERE id=?").run(receipt.id); return;
	}
	try {
		await api(store, "/ingest/picks", {
			session_id: store.get(`recallSession:${receipt.id}`, `agent-recall:${digest(receipt.session)}`),
			picked: JSON.parse(receipt.picked!), offered: JSON.parse(receipt.offered), context: receipt.context,
		}, fetcher);
		store.db.prepare("UPDATE receipts SET state='sent' WHERE id=?").run(receipt.id);
	} catch (error) {
		// No feedback reached the service if obtaining credentials failed, or the
		// service explicitly denied authentication. Retain it for reconnection.
		const denied = error instanceof CredentialUnavailableError || error instanceof DeliveryError && [401, 403].includes(error.status);
		store.db.prepare("UPDATE receipts SET state=? WHERE id=?").run(denied ? "ready" : "delivery_unknown", receipt.id);
		if (denied) store.set("usageRetryAt", Date.now() + 300_000);
	}
}
