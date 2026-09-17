import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, CredentialUnavailableError, DeliveryError } from "./delivery.js";
import { Store } from "./store.js";
import { digest } from "./config.js";
import type { Scope } from "./routing.js";
import { accessToken } from "./auth.js";
import { USAGE_GUIDANCE } from "./hooks.js";
import { createMemoryClient } from "../memory.js";

const ref = z.string().regex(/^(kn|tp|ep):\d+$/);
const receiptArg = z.string().uuid().optional().describe("Receipt from the current Loom hook context. Omit only when hooks are unavailable.");
const cwdArg = z.string().optional().describe("Absolute project directory for .loom.yml lookup when no current-turn receipt is available.");
interface Receipt { id: string; session: string; context: string; offered: string; picked: string | null; state: string }

function active(store: Store, id: string): Receipt {
	const receipt = store.db.prepare("SELECT * FROM receipts WHERE id=?").get(id) as unknown as Receipt | undefined;
	if (!receipt || receipt.state !== "open") throw new Error("This receipt is not active. Use the receipt from the current turn's Loom context.");
	return receipt;
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
	const server = new McpServer({ name: "loom-memory", version: "0.2.3" }, { instructions: USAGE_GUIDANCE });
	const getStore = async (scope: Scope) => typeof source === "function" ? source(scope) : source;
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
			session_id: `agent-recall:${digest(receipt.session)}`,
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
