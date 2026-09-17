import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { accessToken } from "./auth.js";
import type { Store } from "./store.js";
import type { Routing } from "./routing.js";

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,49}(\/[a-z0-9][a-z0-9-]{0,49})?$/);
async function request(store: Store, path: string, body: unknown, fetcher: typeof fetch): Promise<any> {
	const token = await accessToken(store.home, store.config, fetcher);
	const send = (token: string) => fetcher(`${store.config.url}${path}`, { method: body === undefined ? "GET" : "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: AbortSignal.timeout(10_000) });
	let response = await send(token);
	if (response.status === 401 && store.config.oauth) response = await send(await accessToken(store.home, store.config, fetcher, token));
	if (!response.ok) throw new Error(`Graph request failed (HTTP ${response.status}). Verify organization ownership, access and slug. After a timeout, check list_graphs before retrying creation.`);
	return response.json();
}
async function graphs(store: Store, fetcher: typeof fetch) {
	const result = await request(store, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_graphs", arguments: {} } }, fetcher);
	const text = result.result?.content?.find((item: any) => item.type === "text")?.text;
	if (result.result?.isError || !text) throw new Error("Could not verify accessible graphs. The current graph is unchanged.");
	const parsed = z.object({ graphs: z.array(z.object({ id: z.string(), slug: z.string().nullable().optional(), kind: z.string().optional(), name: z.string().nullable().optional() })) }).parse(JSON.parse(text));
	return parsed;
}
export function registerGraphTools(server: McpServer, routing: Routing, fetcher = fetch): void {
	const run = async (fn: () => Promise<unknown>) => {
		try { return { content: [{ type: "text" as const, text: JSON.stringify(await fn()) }] }; }
		catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error && !["ZodError", "SyntaxError"].includes(error.name) ? error.message : "Invalid graph response. The pending data is retained." }] }; }
	};
	server.registerTool("list_graphs", { description: "List accessible Loom graphs before switching.", inputSchema: {}, annotations: { readOnlyHint: true } },
		() => run(async () => graphs(await routing.base(), fetcher)));
	server.registerTool("list_graph_organizations", { description: "List organizations and your role. Graph creation requires ownership.", inputSchema: {}, annotations: { readOnlyHint: true } },
		() => run(async () => request(await routing.base(), "/me/organizations", undefined, fetcher)));
	server.registerTool("create_graph", {
		description: "Create a graph when requested by the user, using the same API as Loom CLI. Creation does not switch sessions: call switch_graph next if requested. Check list_graphs after ambiguous failure before retrying.",
		inputSchema: { organization_id: z.string().uuid(), slug, name: z.string().trim().min(1).max(200) }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
	}, ({ organization_id, ...input }) => run(async () => request(await routing.base(), `/me/organizations/${organization_id}/graphs`, input, fetcher)));
	server.registerTool("switch_graph", {
		description: "Switch this running session and its .loom.yml to an accessible graph requested by the user. Use its current receipt; if recall failed, pass the host session_id and absolute cwd. Use an empty graph for personal memory. Old queued experience and receipts stay in their original graph; subsequent capture uses the selected graph. Other running sessions keep their graph.",
		inputSchema: { graph: z.union([slug, z.literal("")]), receipt: z.string().uuid().optional(), session_id: z.string().min(1).optional(), cwd: z.string().optional() },
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
	}, ({ graph, receipt, session_id, cwd }) => run(async () => {
		const base = await routing.base();
		const available = await graphs(base, fetcher);
		if (!available.graphs.some(g => graph ? g.slug === graph : g.kind === "personal")) throw new Error("The requested graph is not accessible. No configuration was changed.");
		return routing.switchGraph({ receipt, session: session_id, cwd }, graph || null);
	}));
}
