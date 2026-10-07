import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { SERVER_INSTRUCTIONS } from "./hooks.js";

const RECOVERY_MESSAGE = "The Loom worker stopped responding. Its connection is being recovered; saved experience is retained. This operation was not replayed. Before retrying a write, check whether it completed.";

interface Worker {
	client: Client;
	transport: StdioClientTransport;
	exited: Promise<void>;
	ended: boolean;
	stopping?: Promise<void>;
}
interface Options {
	requestTimeoutMs?: number;
	healthTimeoutMs?: number;
	heartbeatMs?: number;
}

/** Keep the host's stdio connection outside the process that owns capture locks,
 * SQLite and network requests. A wedged worker must die before its replacement
 * can recover its lock. Never replay a request whose outcome is ambiguous.
 */
export function createSupervisedServer(workerPath: string, options: Options = {}) {
	const timeout = options.requestTimeoutMs ?? 30_000;
	const healthTimeout = options.healthTimeoutMs ?? 15_000;
	const server = new Server({ name: "loom-memory", version: "0.4.0" }, {
		capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS,
	});
	let worker: Worker | undefined;
	let starting: Promise<Worker> | undefined;
	let retiring: Promise<void> = Promise.resolve();
	let closed = false;
	let checking = false;

	async function stop(current: Worker): Promise<void> {
		if (worker === current) worker = undefined;
		if (!current.stopping) {
			current.stopping = (async () => {
				// The SDK closes stdin, then uses the owned ChildProcess handle for
				// TERM/KILL. Its close() can return just after KILL; also await exit.
				await current.transport.close();
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([current.exited, new Promise<never>((_, reject) => {
						timer = setTimeout(() => reject(new Error("Loom worker exit could not be confirmed.")), 5000);
					})]);
				} finally { clearTimeout(timer); }
			})();
			retiring = current.stopping.catch(error => { closed = true; throw error; });
			// Callers observe the failure; avoid an unhandled rejection while idle.
			void retiring.catch(() => {});
		}
		await current.stopping;
	}

	async function ready(): Promise<Worker> {
		if (closed) throw new Error("Loom supervisor is closed.");
		if (starting) return starting;
		if (worker) return worker;
		starting = (async () => {
			await retiring;
			if (closed) throw new Error("Loom supervisor is closed.");
			const transport = new StdioClientTransport({ command: process.execPath,
				args: [workerPath, "mcp-worker"], stderr: "pipe",
				env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
			});
			// Drain diagnostics so a full stderr pipe cannot stall the worker. Do not
			// relay raw exceptions, credentials or repeated recovery notices to users.
			transport.stderr?.on("data", () => {});
			let finish!: () => void;
			const current: Worker = { client: new Client({ name: "loom-supervisor", version: "0.4.0" }),
				transport, exited: new Promise<void>(resolve => { finish = resolve; }), ended: false };
			transport.onclose = () => {
				current.ended = true; finish();
				if (worker === current) worker = undefined;
			};
			try {
				await current.client.connect(transport, { timeout, maxTotalTimeout: timeout });
				if (closed || current.ended) throw new Error("Loom worker closed during startup.");
				worker = current;
				return current;
			} catch (error) { await stop(current); throw error; }
		})();
		try { return await starting; } finally { starting = undefined; }
	}

	async function request<T>(fn: (client: Client) => Promise<T>): Promise<T> {
		const current = await ready();
		try { return await fn(current.client); }
		catch (error) { await stop(current); throw error; }
	}
	server.setRequestHandler(ListToolsRequestSchema, async (message, extra) => {
		try { return await request(client => client.listTools(message.params, { timeout, maxTotalTimeout: timeout, signal: extra.signal })); }
		catch { throw new McpError(ErrorCode.InternalError, RECOVERY_MESSAGE); }
	});
	server.setRequestHandler(CallToolRequestSchema, async (message, extra) => {
		try { return await request(client => client.callTool(message.params, undefined, { timeout, maxTotalTimeout: timeout, signal: extra.signal })); }
		catch { return { isError: true, content: [{ type: "text", text: RECOVERY_MESSAGE }] }; }
	});
	const timer = setInterval(() => {
		if (checking || closed) return;
		checking = true;
		// Exercise the real config/SQLite status path, rather than a ping which
		// would still succeed when the worker's async file operations are wedged.
		void request(client => client.callTool({ name: "memory_status", arguments: {} }, undefined,
			{ timeout: healthTimeout, maxTotalTimeout: healthTimeout }))
			.catch(() => {}).finally(() => { checking = false; });
	}, options.heartbeatMs ?? 10_000);
	async function close(): Promise<void> {
		closed = true; clearInterval(timer);
		if (starting) await starting.catch(() => {});
		if (worker) await stop(worker);
		await retiring;
	}
	server.onclose = () => { void close().catch(() => {}); };
	return { server, close, get workerPid() { return worker?.transport.pid ?? null; } };
}
