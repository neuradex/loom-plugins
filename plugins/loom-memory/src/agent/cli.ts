import { captureLock } from "./capture-lock.js";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { dataHome, NotConnectedError, readConfig, saveConfig } from "./config.js";
import { captureHook, hookLockWaitMs, recallHook, startFinalDrain } from "./hooks.js";
import { connectionHook, createRuntime } from "./runtime.js";
import { createSupervisedServer } from "./supervisor.js";

process.umask(0o077);
async function stdin(): Promise<unknown> {
	const chunks: Buffer[] = []; let bytes = 0;
	for await (const chunk of process.stdin) {
		const buffer = Buffer.from(chunk); bytes += buffer.length;
		if (bytes > 16_777_216) throw new Error("Hook input exceeds 16 MiB; use transcript collection for large records.");
		chunks.push(buffer);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function main(): Promise<void> {
	const command = process.argv[2];
	if (command === "configure") {
		await saveConfig(await stdin());
		console.log("Loom Memory configured. Full experience capture is enabled unless capture=false was supplied."); return;
	}
	if (!["hook", "mcp", "mcp-worker", "flush", "status"].includes(command ?? "")) {
		console.log("Usage: node cli.js configure < config.json | mcp | hook | flush | status"); return;
	}
	if (command === "mcp") {
		const supervisor = createSupervisedServer(fileURLToPath(import.meta.url));
		const shutdown = () => { void supervisor.close().finally(() => process.exit(0)); };
		// The SDK's stdio transport does not close itself on stdin EOF. Without
		// this, the heartbeat keeps an orphaned supervisor and worker alive.
		process.stdin.once("end", shutdown);
		await supervisor.server.connect(new StdioServerTransport());
		for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, shutdown);
		return;
	}
	if (command === "mcp-worker") {
		// Also handles abrupt supervisor death: its private stdin pipe reaches EOF.
		process.stdin.once("end", () => process.exit(0));
		const runtime = createRuntime();
		let pumping = false;
		const pump = async () => {
			if (pumping) return;
			pumping = true;
			// A stalled lock owner blocks every session until other collectors evict
			// it (STALE_HOLD_MS). Ending this worker sooner keeps that window short;
			// the supervisor confirms exit before restart.
			const watchdog = setTimeout(() => process.exit(1), 60_000);
			try { await runtime.pump(); } finally { clearTimeout(watchdog); pumping = false; }
		};
		const timer = setInterval(() => { void pump(); }, 1000);
		runtime.server.server.onclose = () => { clearInterval(timer); process.exit(0); };
		await runtime.server.connect(new StdioServerTransport());
		void pump(); return;
	}
	if (command === "status") {
		const runtime = createRuntime();
		try { console.log(JSON.stringify(await runtime.status(), null, 2)); } finally { runtime.close(); }
		return;
	}
	const input = command === "hook" ? await stdin() as Record<string, unknown> : undefined;
	let config;
	try { config = await readConfig(); }
	catch (error) {
		if (input && error instanceof NotConnectedError) { console.log(JSON.stringify(await connectionHook(input))); return; }
		throw error;
	}
	const runtime = createRuntime();
	try {
		if (input) {
			const event = String(input.hook_event_name ?? "");
			// Only cursor and receipt work holds the lock, and only for a wait that
			// ends before the host's hook timeout would.
			const { store, project, captureError } = await captureLock(dataHome(), async () => {
				await runtime.routing.recover();
				const selected = await runtime.routing.select({ session: typeof input.session_id === "string" ? input.session_id : undefined,
					cwd: typeof input.cwd === "string" ? input.cwd : undefined });
				if (event === "UserPromptSubmit") {
					for (const prior of await runtime.routing.all()) prior.db.prepare("UPDATE receipts SET state='unknown' WHERE session=? AND state='open'").run(String(input.session_id ?? ""));
				}
				const captureError = captureHook(selected.store, input);
				// A switch can leave the current turn's receipt in an earlier graph.
				if (event === "Stop" && input.stop_hook_active !== true || event === "Interrupt") {
					for (const prior of await runtime.routing.all()) {
						prior.db.prepare("UPDATE receipts SET state=CASE WHEN ? THEN 'aborted' WHEN picked IS NULL THEN 'unknown' ELSE 'ready' END WHERE session=? AND state='open'")
							.run(event === "Interrupt" ? 1 : 0, String(input.session_id ?? ""));
					}
				}
				return { ...selected, captureError };
			}, { waitMs: hookLockWaitMs(event) });
			// Recall is a network round trip; it runs after the lock is released.
			const output = await recallHook(store, input, fetch, project?.file, captureError);
			console.log(JSON.stringify(config.oauth?.needsReconnect ? { ...output, ...await connectionHook(input) } : output));
			if (event === "SessionEnd") startFinalDrain(fileURLToPath(import.meta.url));
		} else if (command === "flush") {
			await runtime.pump(true);
			console.log(JSON.stringify(await runtime.status()));
		} else console.log(JSON.stringify(await runtime.status(), null, 2));
	} finally { runtime.close(); }
}
main().catch((error) => {
	// Never print raw API payloads or config validation objects (which can hold tokens).
	const message = error instanceof Error && !["ZodError", "SyntaxError"].includes(error.name) ? error.message : "Invalid Loom configuration/input.";
	if (process.argv[2] === "hook") console.log(JSON.stringify({ systemMessage: message }));
	else { console.error(message); process.exitCode = 1; }
});
