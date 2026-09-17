import { randomUUID } from "node:crypto";
import { collectAll } from "./collector.js";
import { Store } from "./store.js";
import { accessToken } from "./auth.js";

interface DeliveryState { retryAt: number; failures: number; lastSuccess: number; error?: string }
export class DeliveryError extends Error {
	constructor(readonly status: number, readonly retryAfterMs = 0) { super(`Memory API HTTP ${status}`); }
}
export class CredentialUnavailableError extends Error {
	constructor() { super("Loom authentication is unavailable; the request was not sent."); }
}

export async function api<T>(store: Store, path: string, body: unknown, fetcher = fetch, timeoutMs = 10_000): Promise<T> {
	const credential = async (rejected?: string) => {
		try { return await accessToken(store.home, store.config, fetcher, rejected); }
		catch { throw new CredentialUnavailableError(); }
	};
	const token = await credential();
	const send = (credential: string) => fetcher(`${store.config.url}${path}`, {
		method: "POST", headers: {
			authorization: `Bearer ${credential}`, "content-type": "application/json",
			...(store.config.graph ? { "x-loom-graph": store.config.graph } : {}),
		}, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: "error",
	});
	let response = await send(token);
	// An explicit 401 means the request was rejected before ingestion, so one
	// refreshed retry is safe even for non-idempotent feedback.
	if (response.status === 401 && store.config.oauth) response = await send(await credential(token));
	if (!response.ok) {
		const retry = response.headers.get("retry-after");
		const ms = retry ? (/^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : 0;
		throw new DeliveryError(response.status, Number.isFinite(ms) ? Math.max(0, ms) : 0);
	}
	return await response.json() as T;
}

/** One lease across every local MCP process: opening ten coding sessions does
 * not create ten uploaders competing for the same account's pending batches. */
export async function drain(store: Store, fetcher = fetch, force = false): Promise<void> {
	const owner = randomUUID();
	const claimed = store.transaction(() => {
		const lease = store.get("uploader", { owner: "", until: 0 });
		if (lease.until > Date.now()) return false;
		store.set("uploader", { owner, until: Date.now() + 60_000 }); return true;
	});
	if (!claimed) return;
	try {
		if (!store.config.capture) return;
		collectAll(store);
		store.closeIdleSegments();
		const state = store.get<DeliveryState>("delivery", { retryAt: 0, failures: 0, lastSuccess: 0 });
		if (state.retryAt > Date.now()) return;
		const rows = store.batch();
		if (rows.length) {
			const bytes = rows.reduce((sum, row) => sum + row.bytes, 0);
			const full = rows.length >= store.config.batchEvents || bytes >= store.config.batchBytes / 2;
			if (!force && !full && Date.now() - state.lastSuccess < store.config.flushMs) return;
			const response = await api<{ results: Array<{ idempotency_key: string }> }>(store, "/ingest/episodes/batch", { episodes: rows.map((row) => JSON.parse(row.body)) }, fetcher);
			const confirmed = new Set(response.results?.map((item) => item.idempotency_key));
			if (rows.some((row) => !confirmed.has(row.id))) throw new Error("Incomplete batch acknowledgement");
			store.ack(rows);
			const metrics = store.get("metrics", { batches: 0, events: 0, bytes: 0 });
			store.set("metrics", { batches: metrics.batches + 1, events: metrics.events + rows.length, bytes: metrics.bytes + bytes });
		}
		// Capture acknowledgements precede segmentation. No session-end request can
		// overtake an episode in its segment, including after a restart or 429.
		const ready = store.db.prepare(`SELECT id FROM segments WHERE closed=1 AND finalized=0
		 AND NOT EXISTS (SELECT 1 FROM outbox WHERE segment=segments.id) LIMIT 1`).get();
		if (ready) {
			await api(store, "/ingest/session-end", { session_id: ready.id }, fetcher);
			store.db.prepare("UPDATE segments SET finalized=1 WHERE id=?").run(ready.id as string);
		}
		if (rows.length || ready) store.set("delivery", { retryAt: 0, failures: 0, lastSuccess: Date.now() });
	} catch (error) {
		const state = store.get<DeliveryState>("delivery", { retryAt: 0, failures: 0, lastSuccess: 0 });
		const failures = Math.min(state.failures + 1, 16);
		const permanent = error instanceof DeliveryError && [400, 401, 403, 404, 413, 422].includes(error.status);
		const delay = permanent ? 300_000 : Math.min(300_000, 1000 * 2 ** failures) * (0.5 + Math.random());
		store.set("delivery", {
			...state, failures, retryAt: Date.now() + Math.max(delay, error instanceof DeliveryError ? error.retryAfterMs : 0),
			error: error instanceof DeliveryError ? error.message : "Upload failed or timed out; batch retained for retry.",
		});
	} finally {
		store.transaction(() => {
			if (store.get("uploader", { owner: "" }).owner === owner) store.set("uploader", { owner: "", until: 0 });
		});
	}
}
