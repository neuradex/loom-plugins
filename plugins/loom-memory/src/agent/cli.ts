import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { dataHome, NotConnectedError, readConfig, saveConfig } from "./config.js";
import { Store } from "./store.js";
import { drain } from "./delivery.js";
import { handleHook, startFinalDrain } from "./hooks.js";
import { deliverUsage } from "./server.js";
import { connectionHook, createRuntime } from "./runtime.js";

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
	if (!["hook", "mcp", "flush", "status"].includes(command ?? "")) {
		console.log("Usage: node cli.js configure < config.json | mcp | hook | flush | status"); return;
	}
	if (command === "mcp") {
		const runtime = createRuntime();
		const timer = setInterval(() => { void runtime.pump(); }, 1000);
		runtime.server.server.onclose = () => { clearInterval(timer); process.exit(0); };
		await runtime.server.connect(new StdioServerTransport());
		void runtime.pump(); return;
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
	const store = new Store(dataHome(), config);
	try {
		if (input) {
			const output = await handleHook(store, input);
			console.log(JSON.stringify(config.oauth?.needsReconnect ? { ...output, ...await connectionHook(input) } : output));
			if (input.hook_event_name === "SessionEnd") startFinalDrain(fileURLToPath(import.meta.url));
		} else if (command === "flush") {
			await drain(store, fetch, true); await deliverUsage(store);
			console.log(JSON.stringify(store.status()));
		} else console.log(JSON.stringify(store.status(), null, 2));
	} finally { store.close(); }
}
main().catch((error) => {
	// Never print raw API payloads or config validation objects (which can hold tokens).
	const message = error instanceof Error && !["ZodError", "SyntaxError"].includes(error.name) ? error.message : "Invalid Loom configuration/input.";
	if (process.argv[2] === "hook") console.log(JSON.stringify({ systemMessage: message }));
	else { console.error(message); process.exitCode = 1; }
});
