import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { compactDecrypt, decodeJwt, exportJWK, generateKeyPair, importJWK, type JWK } from "jose";
import { z } from "zod";
import { accountKey, atomicJson, dataHome, NotConnectedError, readConfig, saveConfig, validateConfig, type Config } from "./config.js";

const API_URL = "https://api.neuradex.ai";
interface Pending { nonce: string; public_key: JWK; private_key: JWK; expiresAt: number }

/** Short exclusive lock shared by hook/MCP processes, including refresh rotation. */
export async function authLock<T>(home: string, fn: () => Promise<T>): Promise<T> {
	await mkdir(home, { recursive: true, mode: 0o700 });
	const path = join(home, "auth.lock");
	const deadline = Date.now() + 10_000;
	while (true) {
		try { await mkdir(path, { mode: 0o700 }); break; }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			// A crashed holder cannot leave authentication permanently locked.
			const age = await stat(path).then(s => Date.now() - s.mtimeMs).catch(() => 0);
			if (age > 30_000) { await rm(path, { recursive: true, force: true }); continue; }
			if (Date.now() >= deadline) throw new Error("Loom authentication is busy; retry shortly.");
			await new Promise(resolve => setTimeout(resolve, 50));
		}
	}
	try { return await fn(); } finally { await rm(path, { recursive: true, force: true }); }
}

export async function connectionRequest(home = dataHome()): Promise<{ nonce: string; public_key: JWK }> {
	return authLock(home, async () => {
		let pending: Pending | undefined;
		try { pending = JSON.parse(await readFile(join(home, "connection.json"), "utf8")); } catch { /* first connection */ }
		if (!pending || pending.expiresAt < Date.now()) {
			const keys = await generateKeyPair("ECDH-ES", { extractable: true });
			pending = { nonce: randomBytes(32).toString("base64url"), public_key: await exportJWK(keys.publicKey),
				private_key: await exportJWK(keys.privateKey), expiresAt: Date.now() + 600_000 };
			await atomicJson(join(home, "connection.json"), pending);
		}
		return { nonce: pending.nonce, public_key: pending.public_key };
	});
}

const tokensSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1),
	expires_in: z.number().positive().max(86_400), scope: z.string() });

function checkIdentity(token: string, userId: string): void {
	// Signature trust comes from the fixed HTTPS issuer (and MCP on enrollment).
	const claims = decodeJwt(token);
	const scope = Array.isArray(claims.scope) ? claims.scope : typeof claims.scope === "string" ? claims.scope.split(" ") : [];
	if (claims.sub !== userId || claims.aud !== "mcp" || !scope.includes("memory:read") || !scope.includes("memory:write")) {
		throw new Error("Loom returned a credential for a different identity or permission scope.");
	}
}

export async function completeConnection(encrypted: string, home = dataHome(), fetcher = fetch): Promise<void> {
	await authLock(home, async () => {
		let pending: Pending;
		try { pending = JSON.parse(await readFile(join(home, "connection.json"), "utf8")); }
		catch { throw new Error("No pending Loom connection. Read memory_status to start one."); }
		if (pending.expiresAt < Date.now()) throw new Error("Loom connection request expired. Read memory_status and connect again.");
		const key = await importJWK(pending.private_key, "ECDH-ES");
		const { plaintext } = await compactDecrypt(encrypted, key, { keyManagementAlgorithms: ["ECDH-ES"], contentEncryptionAlgorithms: ["A256GCM"] });
		const payload = z.object({ nonce: z.literal(pending.nonce), user_id: z.string().uuid(), expires_at: z.number() })
			.and(tokensSchema).parse(JSON.parse(new TextDecoder().decode(plaintext)));
		if (payload.expires_at < Date.now() || payload.expires_at > Date.now() + 180_000) throw new Error("Loom connection response expired.");
		checkIdentity(payload.access_token, payload.user_id);
		let previous: Config | undefined;
		try { previous = await readConfig(home); } catch (error) { if (!(error instanceof NotConnectedError)) throw error; }
		if (previous && (!previous.userId || previous.userId !== payload.user_id)) {
			throw new Error("This collector already belongs to another enrollment. Disconnect it before switching accounts; its queue is retained.");
		}
		// An explicit process environment override supports local development. Never
		// accept an issuer URL from a tool result or from a project's configuration.
		const url = validateConfig({ token: "url-validation", url: previous?.url ?? process.env.LOOM_MEMORY_API_URL ?? API_URL }).url;
		// /me/graphs is internal to memory, not a public ALB route. Verify through
		// the same stateless public MCP endpoint that the host just authenticated.
		const response = await fetcher(`${url}/mcp`, { method: "POST", headers: {
			authorization: `Bearer ${payload.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream",
		}, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_graphs", arguments: {} } }),
			redirect: "error", signal: AbortSignal.timeout(8000) });
		if (!response.ok) throw new Error("Loom could not verify the collector account. Reconnect Loom and retry.");
		const rpc = await response.json() as { result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> } };
		const text = rpc.result?.content?.find(item => item.type === "text")?.text;
		if (rpc.result?.isError || !text) throw new Error("Loom account verification failed.");
		const result = JSON.parse(text) as { graphs?: Array<{ kind: string; id: string }> };
		if (!result.graphs?.some(g => g.kind === "personal" && g.id === payload.user_id)) throw new Error("Loom account verification did not match.");
		await saveConfig({ ...previous, url, userId: payload.user_id, token: payload.access_token,
			oauth: { refreshToken: payload.refresh_token, expiresAt: Date.now() + payload.expires_in * 1000 } }, home);
		await rm(join(home, "connection.json"), { force: true });
	});
}

/** Never race two rotating refreshes or replay a queue under a newly signed-in user. */
export async function accessToken(home: string, current: Config, fetcher = fetch, rejectedToken?: string): Promise<string> {
	if (!current.oauth) return current.token;
	return authLock(home, async () => {
		const latest = await readConfig(home);
		if (accountKey(latest) !== accountKey(current) || !latest.oauth) throw new Error("Loom account changed; the old queue remains isolated.");
		if (latest.oauth.needsReconnect) throw new NotConnectedError();
		if (latest.oauth.expiresAt > Date.now() + 60_000 && (!rejectedToken || latest.token !== rejectedToken)) {
			Object.assign(current, latest); return latest.token;
		}
		const response = await fetcher(`${latest.url}/oauth/token`, {
			method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: latest.oauth.refreshToken }),
			redirect: "error", signal: AbortSignal.timeout(8000),
		});
		if (!response.ok) {
			if (response.status === 400 || response.status === 401) {
				latest.oauth.needsReconnect = true; await saveConfig(latest, home);
				throw new NotConnectedError();
			}
			throw new Error("Loom token refresh is temporarily unavailable; captured experiences remain queued.");
		}
		const tokens = tokensSchema.parse(await response.json());
		checkIdentity(tokens.access_token, latest.userId!);
		const updated = { ...latest, token: tokens.access_token,
			oauth: { refreshToken: tokens.refresh_token, expiresAt: Date.now() + tokens.expires_in * 1000 } };
		await saveConfig(updated, home); Object.assign(current, updated); return updated.token;
	});
}
