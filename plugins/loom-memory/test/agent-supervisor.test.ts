import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSupervisedServer } from "../src/agent/supervisor.js";
import { validateConfig, type Config } from "../src/agent/config.js";
import { Store } from "../src/agent/store.js";
import { appendRecord } from "../src/agent/collector.js";

const bundle = mkdtempSync(join(tmpdir(), "loom-supervised-bundle-"));
const cleanup: Array<() => unknown> = [];
beforeAll(async () => {
	await promisify(execFile)(process.execPath, [resolve("scripts/build-memory-plugin.mjs"), bundle]);
	writeFileSync(join(bundle, "package.json"), '{"type":"module"}');
});
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.unstubAllEnvs(); });
afterAll(() => rmSync(bundle, { recursive: true, force: true }));

async function fixture(options: { heartbeatMs?: number; capture?: boolean } = {}) {
	const home = mkdtempSync(join(tmpdir(), "loom-supervised-home-"));
	cleanup.push(() => rmSync(home, { recursive: true, force: true }));
	let acceptUploads = false;
	let writes = 0;
	const delivered: Array<{ idempotency_key: string; content: string }> = [];
	const http = createServer(async (req, res) => {
		const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
		if (req.url?.endsWith("/graphs")) { writes++; return; } // committed, response lost
		if (req.url === "/ingest/episodes/batch") {
			if (!acceptUploads) { res.writeHead(429, { "retry-after": "1" }); res.end(); return; }
			delivered.push(...body.episodes);
			res.end(JSON.stringify({ results: body.episodes.map((ep: { idempotency_key: string }) => ({ idempotency_key: ep.idempotency_key })) })); return;
		}
		res.end('{"ok":true}');
	});
	await new Promise<void>(done => http.listen(0, "127.0.0.1", done));
	cleanup.push(() => new Promise<void>(done => { http.closeAllConnections(); http.close(() => done()); }));
	const config = validateConfig({ token: "fixture-token", url: `http://127.0.0.1:${(http.address() as { port: number }).port}`,
		capture: options.capture ?? false, flushMs: 1000 });
	writeFileSync(join(home, "config.json"), JSON.stringify(config));
	const store = new Store(home, config);
	const raw = JSON.stringify({ type: "user", uuid: "preserve-me", message: { role: "user", content: "retain every byte through recovery" } });
	appendRecord(store, store.source("surviving-session", ""), raw, 0);
	const key = store.batch()[0]!.id; store.close();
	vi.stubEnv("LOOM_MEMORY_HOME", home);
	const supervisor = createSupervisedServer(join(bundle, "dist/cli.js"), {
		requestTimeoutMs: 2000, healthTimeoutMs: 500, heartbeatMs: options.heartbeatMs ?? 60_000,
	});
	cleanup.push(() => supervisor.close());
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await supervisor.server.connect(serverSide);
	const client = new Client({ name: "persistent-host", version: "1" });
	await client.connect(clientSide); cleanup.push(() => client.close());
	expect((await client.listTools()).tools.map(tool => tool.name)).toContain("memory_status");
	return { home, config, raw, key, supervisor, client, delivered,
		allowUploads() { acceptUploads = true; }, writes: () => writes };
}
function value(result: Awaited<ReturnType<Client["callTool"]>>) {
	return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
}
async function expectDelivered(f: Awaited<ReturnType<typeof fixture>>) {
	try { await expect.poll(() => f.delivered.length, { timeout: 8000 }).toBe(1); }
	catch (error) {
		const store = new Store(f.home, f.config);
		try {
			const pidFile = join(f.home, "capture.lock", "pid");
			console.error(JSON.stringify({ workerPid: f.supervisor.workerPid,
				captureOwner: existsSync(pidFile) ? readFileSync(pidFile, "utf8") : null,
				lease: store.get("uploader", {}), delivery: store.get("delivery", {}), queue: store.batch().length }));
		} finally { store.close(); }
		throw error;
	}
}
function holdCaptureLock(home: string, pid: number, config: Config) {
	// Fix the interruption point instead of relying on the worker happening to
	// own its upload lease when the scheduler pauses it (observed in Linux CI).
	const store = new Store(home, config);
	try { store.set("uploader", { owner: "stalled-fixture", pid, until: Date.now() + 60_000 }); }
	finally { store.close(); }
	process.kill(pid, "SIGSTOP");
	// Reproduce the observed state: a live, nonresponsive worker owns the shared
	// capture lock. Other collectors leave it alone while the owner is alive and
	// inside the stale-hold bound; recovery comes from the supervisor ending it.
	const lock = join(home, "capture.lock");
	if (!existsSync(lock)) mkdirSync(lock);
	// SIGSTOP can land between mkdir and the worker's asynchronous PID write.
	// Publish the fixture's owner explicitly even when that directory exists;
	// otherwise this tests an ownerless lock's grace period instead of recovery
	// from the fully published live-owner lock observed in the incident.
	writeFileSync(join(lock, "pid"), String(pid));
	expect(readFileSync(join(lock, "pid"), "utf8")).toBe(String(pid));
}

it("bounds concurrent stalled requests and recovers the same host connection without losing queued experience", async () => {
	const f = await fixture({ capture: true });
	const oldPid = f.supervisor.workerPid!;
	holdCaptureLock(f.home, oldPid, f.config);
	const start = Date.now();
	const results = await Promise.all([1, 2].map(() => f.client.callTool({ name: "memory_status", arguments: {} })));
	expect(results.every(result => result.isError)).toBe(true);
	expect(Date.now() - start).toBeLessThan(9000);
	expect(() => process.kill(oldPid, 0)).toThrow();
	const result = await f.client.callTool({ name: "memory_status", arguments: {} });
	expect(result.isError).not.toBe(true);
	expect(value(result).queue.events).toBe(1);
	expect(f.supervisor.workerPid).not.toBe(oldPid);
	f.allowUploads();
	await expectDelivered(f);
	expect(f.delivered[0]).toMatchObject({ idempotency_key: f.key, content: f.raw });
	await expect.poll(async () => value(await f.client.callTool({ name: "memory_status", arguments: {} })).queue.events).toBe(0);
}, 25_000);

it("recovers an idle stalled worker and its capture lock without a host restart or a foreground request", async () => {
	const f = await fixture({ heartbeatMs: 100, capture: true });
	const oldPid = f.supervisor.workerPid!;
	holdCaptureLock(f.home, oldPid, f.config);
	f.allowUploads();
	await expect.poll(() => f.supervisor.workerPid, { timeout: 10_000 }).toSatisfy((pid: number | null) => pid !== null && pid !== oldPid);
	expect(() => process.kill(oldPid, 0)).toThrow();
	await expectDelivered(f);
	expect(f.delivered[0]).toMatchObject({ idempotency_key: f.key, content: f.raw });
	expect((await f.client.callTool({ name: "memory_status", arguments: {} })).isError).not.toBe(true);
}, 25_000);

it("never replays an ambiguous graph creation when replacing an unresponsive worker", async () => {
	const f = await fixture();
	const oldPid = f.supervisor.workerPid!;
	const result = await f.client.callTool({ name: "create_graph", arguments: {
		organization_id: "11111111-1111-4111-8111-111111111111", slug: "once", name: "Once",
	} });
	expect(result.isError).toBe(true);
	expect(JSON.stringify(result)).toContain("not replayed");
	expect(f.writes()).toBe(1);
	expect((await f.client.callTool({ name: "memory_status", arguments: {} })).isError).not.toBe(true);
	expect(f.supervisor.workerPid).not.toBe(oldPid);
	expect(f.writes()).toBe(1);
}, 15_000);

it.each(["SIGTERM", "SIGKILL"] as const)("does not orphan a worker when the installed supervisor receives %s", async signal => {
	const home = mkdtempSync(join(tmpdir(), "loom-parent-exit-"));
	cleanup.push(() => rmSync(home, { recursive: true, force: true }));
	writeFileSync(join(home, "config.json"), JSON.stringify({ token: "fixture-token", capture: false, recall: false }));
	const transport = new StdioClientTransport({ command: process.execPath,
		args: [join(bundle, "dist/cli.js"), "mcp"], env: { LOOM_MEMORY_HOME: home }, stderr: "pipe" });
	transport.stderr?.on("data", () => {});
	const client = new Client({ name: "closing-host", version: "1" });
	await client.connect(transport); cleanup.push(() => client.close());
	expect((await client.callTool({ name: "memory_status", arguments: {} })).isError).not.toBe(true);
	const parent = transport.pid!;
	const children = execFileSync("ps", ["-axo", "pid,ppid"], { encoding: "utf8" }).trim().split("\n").slice(1)
		.map(line => line.trim().split(/\s+/).map(Number)).filter(([, ppid]) => ppid === parent).map(([pid]) => pid!);
	expect(children).toHaveLength(1);
	const child = children[0]!;
	process.kill(parent, signal);
	await expect.poll(() => { try { process.kill(child, 0); return true; } catch { return false; } }, { timeout: 3000 }).toBe(false);
}, 10_000);
