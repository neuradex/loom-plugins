import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CompactEncrypt, importJWK } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { accessToken, completeConnection, connectionRequest } from "../src/agent/auth.js";
import { accountKey, readConfig, saveConfig } from "../src/agent/config.js";
import { createRuntime, connectionHook } from "../src/agent/runtime.js";
import { Store } from "../src/agent/store.js";
import { handleHook } from "../src/agent/hooks.js";
import { api, drain } from "../src/agent/delivery.js";
import { deliverUsage } from "../src/agent/server.js";
import { SignJWT } from "jose";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const signConnectorToken = () => new SignJWT({ scope: "memory:read memory:write" }).setProtectedHeader({alg:"HS256"})
 .setSubject(USER_ID).setAudience("mcp").setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode("fixture-secret"));

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture() {
	const home = await mkdtemp(join(tmpdir(), "loom-auth-"));
	cleanup.push(() => rm(home, { recursive: true, force: true }));
	const token = await signConnectorToken();
	// Standard JWE issuer fixture. The real gateway/OAuth/PG path is tested in nd-cloud.
	const issue = async (request: any) => Response.json({ encrypted: await new CompactEncrypt(new TextEncoder().encode(JSON.stringify({
	 nonce: request.nonce, user_id: USER_ID, expires_at: Date.now()+120000, access_token: token,
	 refresh_token: "synthetic-refresh", expires_in: 3600, scope: "memory:read memory:write",
	}))).setProtectedHeader({alg:"ECDH-ES",enc:"A256GCM"}).encrypt(await importJWK(request.public_key,"ECDH-ES")) });
	const verify = (async () => Response.json({ result: { content: [{ type: "text", text: JSON.stringify({ graphs: [{ kind: "personal", id: USER_ID }] }) }] } })) as typeof fetch;
	async function connect() {
		const request = await connectionRequest(home);
		const response = await issue(request); expect(response.status).toBe(200);
		const { encrypted } = await response.json() as { encrypted: string };
		expect(encrypted).not.toContain(token);
		await completeConnection(encrypted, home, verify);
		return { encrypted, config: await readConfig(home) };
	}
	return { home, token, issue, verify, connect };
}

describe("one-login collector enrollment", () => {
	it("keeps local MCP available before login, connects without restart, and captures/recalls/reports", async () => {
		const f = await fixture();
		const requests: Array<{ path: string; body: any }> = [];
		const fetcher = (async (url, init) => {
			const path = new URL(String(url)).pathname;
			if (path === "/mcp") return f.verify(url, init);
			const body = JSON.parse(String(init?.body)); requests.push({ path, body });
			expect(init?.headers).toMatchObject({ authorization: expect.stringMatching(/^Bearer /) });
			if (path === "/retrieve") return Response.json({ candidate_lines: ['<knowledge id="9">prior lesson</knowledge>'], candidates: [{ ref: "kn:9" }] });
			if (path === "/ingest/episodes/batch") return Response.json({ results: body.episodes.map((e: any) => ({ idempotency_key: e.idempotency_key })) });
			return Response.json({ ok: true });
		}) as typeof fetch;
		const runtime = createRuntime(f.home, fetcher); cleanup.push(() => runtime.close());
		const [a, b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: "first-install", version: "1" });
		await runtime.server.connect(a); await client.connect(b); cleanup.push(() => client.close());
		await runtime.pump(); expect(requests).toHaveLength(0);
		const before = await client.callTool({ name: "memory_status", arguments: {} });
		const status = JSON.parse((before.content as any)[0].text);
		expect(status.connection).toBe("authentication_required");
		const issued = await f.issue(status.request);
		const encrypted = await issued.json();
		const finished = await client.callTool({ name: "complete_connection", arguments: encrypted as any });
		expect(finished.isError).toBeUndefined();
		const store = await runtime.getStore();
		const transcript = join(f.home, "session.jsonl");
		await writeFile(transcript, JSON.stringify({ type: "user", message: { role: "user", content: "first experience" } }) + "\n");
		const input = { session_id: "first", transcript_path: transcript, hook_event_name: "UserPromptSubmit", prompt: "prior lesson?" };
		const hook = await handleHook(store, input, fetcher);
		const receipt = ((hook.hookSpecificOutput as any).additionalContext as string).match(/Receipt: ([\w-]+)/)![1]!;
		await client.callTool({ name: "report_memory_use", arguments: { receipt, picked: ["kn:9"] } });
		await handleHook(store, { ...input, hook_event_name: "Stop" }, fetcher);
		await drain(store, fetcher, true); await deliverUsage(store, fetcher);
		expect(requests.map(r => r.path)).toEqual(["/retrieve", "/ingest/episodes/batch", "/ingest/picks"]);
		expect(requests.at(-1)!.body.picked).toEqual(["kn:9"]);
		expect(store.status()).toMatchObject({ queue: { events: 0 } });
		expect(JSON.stringify(await runtime.status())).not.toContain(store.config.token);
		expect((await stat(join(f.home, "config.json"))).mode & 0o777).toBe(0o600);
	});
	it("binds ciphertext to this installation and consumes the local request once", async () => {
		const f = await fixture(); const other = await fixture();
		await connectionRequest(other.home);
		const { encrypted } = await f.connect();
		await expect(completeConnection(encrypted, other.home, other.verify)).rejects.toThrow();
		await expect(completeConnection(encrypted, f.home, f.verify)).rejects.toThrow("No pending");
	});
	it("checks nonce, expiry, issuer-verified account, and refuses changing an existing identity", async () => {
		const f = await fixture(); const request = await connectionRequest(f.home);
		const key = await importJWK(request.public_key, "ECDH-ES");
		const payload = { nonce: request.nonce, user_id: USER_ID, expires_at: Date.now() + 120000,
			access_token: f.token, refresh_token: "test", expires_in: 3600, scope: "memory:read memory:write" };
		const seal = (body: unknown) => new CompactEncrypt(new TextEncoder().encode(JSON.stringify(body)))
			.setProtectedHeader({ alg: "ECDH-ES", enc: "A256GCM" }).encrypt(key);
		for (const altered of [{ ...payload, nonce: "wrong" }, { ...payload, expires_at: Date.now() - 1 }, { ...payload, user_id: randomUUID() }]) {
			await expect(completeConnection(await seal(altered), f.home, f.verify)).rejects.toThrow();
		}
		const wrongAccount = (async () => Response.json({ result: { content: [{ type: "text", text: JSON.stringify({ graphs: [{ kind: "personal", id: randomUUID() }] }) }] } })) as typeof fetch;
		await expect(completeConnection(await seal(payload), f.home, wrongAccount)).rejects.toThrow("verification");
		await saveConfig({ token: "another", userId: randomUUID() }, f.home);
		await expect(completeConnection(await seal(payload), f.home, f.verify)).rejects.toThrow("another enrollment");
	});
	it("does not print repeated setup errors on tool/Stop/compaction hooks", async () => {
		const f = await fixture();
		for (const event of ["PostToolUse", "PreToolUse", "Stop", "PreCompact", "SessionEnd"]) {
			expect(await connectionHook({ hook_event_name: event }, f.home)).toEqual({});
		}
		const hook = await connectionHook({ hook_event_name: "SessionStart" }, f.home);
		expect(hook.systemMessage).toBeUndefined(); expect(JSON.stringify(hook)).toContain("connect_collector");
		expect(JSON.stringify(hook)).not.toContain("private_key");
	});
});

describe("refresh and outbox ownership", () => {
	it("serializes concurrent refreshes and retains the same queue after restart", async () => {
		const f = await fixture(); const { config } = await f.connect();
		config.oauth!.expiresAt = 1; await saveConfig(config, f.home);
		const store = new Store(f.home, config);
		const source = store.source("ongoing", "");
		store.transaction(() => store.append(source, { idempotency_key: "retained", actor_type: "user", type: "message", content: "pending", metadata: {} }));
		store.close();
		const key = accountKey(config); let calls = 0;
		const refresh = (async () => { calls++; await new Promise(r => setTimeout(r, 30)); return Response.json({ access_token: f.token, refresh_token: "rotated", expires_in: 3600, scope: "memory:read memory:write" }); }) as typeof fetch;
		await Promise.all([accessToken(f.home, { ...config }, refresh), accessToken(f.home, { ...config }, refresh)]);
		expect(calls).toBe(1);
		const latest = await readConfig(f.home); expect(accountKey(latest)).toBe(key);
		const resumed = new Store(f.home, latest); cleanup.push(() => resumed.close());
		expect(resumed.batch()).toHaveLength(1);
		expect(latest.oauth!.refreshToken).toBe("rotated");
	});
	it("retries an explicit 401 once with a refreshed credential", async () => {
		const f = await fixture(); const { config } = await f.connect();
		const store = new Store(f.home, config); cleanup.push(() => store.close()); let tries = 0, refreshes = 0;
		const fetcher = (async url => {
			if (String(url).endsWith("/oauth/token")) { refreshes++; return Response.json({ access_token: f.token, refresh_token: "rotated", expires_in: 3600, scope: "memory:read memory:write" }); }
			tries++; return tries === 1 ? new Response(null, { status: 401 }) : Response.json({ ok: true });
		}) as typeof fetch;
		expect(await api(store, "/ingest/picks", {}, fetcher)).toEqual({ ok: true });
		expect([tries, refreshes]).toEqual([2, 1]);
	});
	it("keeps expired grants queued, signals reconnect, and never repeatedly rotates a revoked token", async () => {
		const f = await fixture(); const { config } = await f.connect(); config.oauth!.expiresAt = 1; await saveConfig(config, f.home);
		let calls = 0; const revoked = (async () => { calls++; return new Response(null, { status: 400 }); }) as typeof fetch;
		await expect(accessToken(f.home, config, revoked)).rejects.toThrow();
		await expect(accessToken(f.home, config, revoked)).rejects.toThrow(); expect(calls).toBe(1);
		const runtime = createRuntime(f.home, revoked); cleanup.push(() => runtime.close());
		expect(await runtime.status()).toMatchObject({ connection: "authentication_required", request: { nonce: expect.any(String) } });
	});
	it("refuses to upload an old identity's queue with a replacement account", async () => {
		const f = await fixture(); const { config } = await f.connect();
		await saveConfig({ ...config, userId: randomUUID() }, f.home);
		await expect(accessToken(f.home, config, f.verify)).rejects.toThrow("account changed");
	});
	it("retains explicit feedback when refresh fails before any feedback request is sent", async () => {
		const f = await fixture(); const { config } = await f.connect(); config.oauth!.expiresAt = 1; await saveConfig(config, f.home);
		const store = new Store(f.home, config); cleanup.push(() => store.close());
		store.db.prepare("INSERT INTO receipts(id,session,context,offered,picked,state) VALUES (?,?,?,?,?,?)")
			.run("pending", "s", "task", '["kn:1"]', '["kn:1"]', "ready");
		let calls = 0;
		await deliverUsage(store, (async url => { calls++; expect(String(url)).toContain("/oauth/token"); return new Response(null, { status: 400 }); }) as typeof fetch);
		expect(calls).toBe(1);
		expect(store.db.prepare("SELECT state FROM receipts WHERE id='pending'").get()!.state).toBe("ready");
	});
});
