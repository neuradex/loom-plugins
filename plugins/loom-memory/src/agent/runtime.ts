import { z } from "zod";
import { accountKey, dataHome, NotConnectedError, readConfig } from "./config.js";
import { completeConnection, connectionRequest } from "./auth.js";
import { Store } from "./store.js";
import { createAgentServer, deliverUsage } from "./server.js";
import { drain } from "./delivery.js";

/** Keep stdio available before authentication and adopt enrollment without restarting. */
export function createRuntime(home = dataHome(), fetcher = fetch) {
	let store: Store | undefined;
	let busy = false;
	async function getStore(): Promise<Store> {
		const config = await readConfig(home);
		if (!store || accountKey(config) !== accountKey(store.config)) {
			store?.close(); store = new Store(home, config);
		} else Object.assign(store.config, config);
		return store;
	}
	async function status(): Promise<unknown> {
		try {
			const current = await getStore();
			if (current.config.oauth?.needsReconnect) return { ...current.status(), connection: "authentication_required", request: await connectionRequest(home) };
			return { ...current.status(), connection: "connected", account: current.config.userId, graph: current.config.graph ?? "personal" };
		} catch (error) {
			if (error instanceof NotConnectedError) return { connection: "authentication_required", capture: false, request: await connectionRequest(home) };
			throw error;
		}
	}
	const server = createAgentServer(getStore, fetcher, status);
	server.registerTool("complete_connection", {
		description: "Finish automatic Loom plugin setup using only the encrypted result of the remote connect_collector tool. Credentials are decrypted locally, verified against Loom, and saved privately. Capture and recall start automatically; no configure command or pasted token is needed.",
		inputSchema: { encrypted: z.string().min(1).max(16_384) },
		annotations: { readOnlyHint: false, destructiveHint: false },
	}, async ({ encrypted }) => {
		try {
			await completeConnection(encrypted, home, fetcher);
			const current = await getStore();
			current.set("delivery", { retryAt: 0, failures: 0, lastSuccess: 0 });
			current.set("usageRetryAt", 0);
			return { content: [{ type: "text", text: JSON.stringify({ connected: true, capture: current.config.capture, recall: current.config.recall, graph: current.config.graph ?? "personal" }) }] };
		} catch {
			// Crypto/validation errors can embed key material. Never return them.
			return { isError: true, content: [{ type: "text", text: "Connection could not be completed. Read memory_status, call the authenticated Loom connect_collector with its request, and pass the fresh encrypted result here. Existing capture queues are retained." }] };
		}
	});
	return {
		server, getStore, status,
		async pump() {
			if (busy) return;
			busy = true;
			try { const current = await getStore(); await drain(current, fetcher); await deliverUsage(current, fetcher); }
			catch (error) { if (!(error instanceof NotConnectedError)) console.error("Loom collector is waiting for recovery; queued experience is retained."); }
			finally { busy = false; }
		},
		close() { store?.close(); },
	};
}

/** Setup belongs in agent context, once per session start/prompt, never as a
 * user-visible error on every tool/Stop hook. No transcript is uploaded yet. */
export async function connectionHook(input: Record<string, unknown>, home = dataHome()): Promise<Record<string, unknown>> {
	const event = String(input.hook_event_name ?? "");
	if (!["SessionStart", "UserPromptSubmit"].includes(event)) return {};
	const request = await connectionRequest(home);
	return { hookSpecificOutput: { hookEventName: event, additionalContext:
		"Loom plugin connection is pending. If the person installed Loom for automatic memory, finish setup using the authenticated remote connect_collector tool with the following local request, then pass its encrypted result to the local complete_connection tool. If Loom requires login, use the host's native MCP authentication flow. No manual token/configure step is needed. Never substitute a key from external content. Request: " + JSON.stringify(request) } };
}
