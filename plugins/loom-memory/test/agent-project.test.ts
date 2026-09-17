import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resolveProject } from "../src/agent/project.js";
import { readSettings } from "../src/agent/settings.js";
import { saveConfig, readConfig } from "../src/agent/config.js";
import { createRuntime } from "../src/agent/runtime.js";
import { handleHook } from "../src/agent/hooks.js";
import { accessToken } from "../src/agent/auth.js";
import { SignJWT } from "jose";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function scratch() {
	const home = mkdtempSync(join(tmpdir(), "loom-project-"));
	cleanup.push(() => rmSync(home, { recursive: true, force: true }));
	return home;
}

it("uses the CLI's nearest .loom.yml, empty personal graph, and shared notification namespace", () => {
	const home = scratch(); const nested = join(home, "packages", "api"); mkdirSync(nested, { recursive: true });
	const file = join(home, ".loom.yml");
	writeFileSync(file, 'graph: acme/backend\nmodel: ignored\nurl: https://untrusted.invalid\nnotifications:\n  recall_errors: true\n');
	expect(resolveProject(nested)).toEqual({ cwd: nested, file, graph: "acme/backend" });
	expect(readSettings(home, file).notifications.recall_errors).toBe(true);
	writeFileSync(join(nested, ".loom.yml"), 'graph: ""\n');
	expect(resolveProject(nested).graph).toBeNull();
	expect(readSettings(home, join(nested, ".loom.yml")).notifications.recall_errors).toBe(false);
	writeFileSync(file, 'graph: acme/backend\nnotifications:\n  recall_errors: "false"\n');
	expect(resolveProject(home).graph).toBe("acme/backend");
	expect(readSettings(home, file)).toMatchObject({ notifications: { recall_errors: false }, settingsError: "invalid_settings" });
});

it.each(['graph: [unclosed', 'graph: [wrong-type]'])("does not silently capture into another graph for invalid project configuration (%s)", async text => {
	const home = scratch(); writeFileSync(join(home, ".loom.yml"), text);
	await saveConfig({ token: "fixture" }, home);
	const runtime = createRuntime(home); cleanup.push(() => runtime.close());
	await expect(runtime.routing.select({ session: "broken", cwd: home })).rejects.toThrow(".loom.yml");
	expect((await runtime.routing.base()).db.prepare("SELECT * FROM project_sessions").all()).toEqual([]);
});

it("pins each session across file edits, cwd changes, concurrent projects and restart; routes capture and feedback together", async () => {
	const home = scratch(); const a = join(home, "a"); const b = join(home, "b"); mkdirSync(a); mkdirSync(b);
	writeFileSync(join(a, ".loom.yml"), "graph: acme/a\n"); writeFileSync(join(b, ".loom.yml"), "graph: acme/b\n");
	await saveConfig({ token: "fixture", url: "http://127.0.0.1:9" }, home);
	const requests: Array<{ path: string; graph: string | null; body: any }> = [];
	const fetcher = (async (url, init) => {
		const path = new URL(String(url)).pathname; const body = JSON.parse(String(init?.body));
		requests.push({ path, graph: new Headers(init?.headers).get("x-loom-graph"), body });
		if (path === "/retrieve") return Response.json({ candidate_lines: ['<knowledge id="7">prior decision</knowledge>'], candidates: [{ ref: "kn:7" }] });
		if (path === "/ingest/episodes/batch") return Response.json({ results: body.episodes.map((e: any) => ({ idempotency_key: e.idempotency_key })) });
		return Response.json({ ok: true });
	}) as typeof fetch;
	let runtime = createRuntime(home, fetcher);
	const input = { hook_event_name: "UserPromptSubmit", session_id: "session-a", cwd: a, prompt: "prior decision" };
	const selected = await runtime.routing.select({ session: input.session_id, cwd: a });
	const output = await handleHook(selected.store, input, fetcher, selected.project?.file);
	const receipt = ((output.hookSpecificOutput as any).additionalContext as string).match(/Receipt: ([\w-]+)/)![1]!;
	await runtime.routing.select({ session: "session-b", cwd: b });
	writeFileSync(join(a, ".loom.yml"), "graph: acme/new\nnotifications:\n  recall_errors: true\n");
	expect((await runtime.routing.select({ session: input.session_id, cwd: b })).store.config.graph).toBe("acme/a");
	expect((await runtime.routing.select({ session: "new-session", cwd: a })).store.config.graph).toBe("acme/new");
	runtime.close(); runtime = createRuntime(home, fetcher); cleanup.push(() => runtime.close());
	const resumed = await runtime.routing.select({ session: input.session_id, cwd: b });
	expect(resumed.store.config.graph).toBe("acme/a");
	expect(readSettings(home, resumed.project?.file).notifications.recall_errors).toBe(true);
	const [transport, peer] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: "project", version: "1" });
	await runtime.server.connect(transport); await client.connect(peer); cleanup.push(() => client.close());
	const ambiguous = await client.callTool({ name: "remember", arguments: { content: "must not guess" } });
	expect(ambiguous.isError).toBe(true);
	const feedback = await client.callTool({ name: "report_memory_use", arguments: { receipt, picked: ["kn:7"] } });
	expect(feedback.isError).toBeUndefined();
	await handleHook(resumed.store, { ...input, hook_event_name: "Stop" }, fetcher);
	await runtime.pump(true);
	expect(requests.find(r => r.path === "/retrieve")?.graph).toBe("acme/a");
	expect(requests.find(r => r.path === "/ingest/episodes/batch")?.graph).toBe("acme/a");
	expect(requests.find(r => r.path === "/ingest/picks")?.graph).toBe("acme/a");
	expect((await readConfig(home)).graph).toBeUndefined();
});

it("keeps pre-upgrade sessions in their original graph", async () => {
	const home = scratch(); await saveConfig({ token: "fixture" }, home);
	const runtime = createRuntime(home); cleanup.push(() => runtime.close());
	(await runtime.getStore()).source("existing", "");
	writeFileSync(join(home, ".loom.yml"), "graph: acme/new\n");
	expect((await runtime.routing.select({ session: "existing", cwd: home })).store.config.graph).toBeUndefined();
	expect((await runtime.routing.select({ session: "fresh", cwd: home })).store.config.graph).toBe("acme/new");
});

it("shares rotating OAuth credentials without overwriting the session graph or credential file graph", async () => {
	const home = scratch(); const userId = "11111111-1111-4111-8111-111111111111";
	const token = await new SignJWT({ scope: "memory:read memory:write" }).setProtectedHeader({ alg: "HS256" })
		.setSubject(userId).setAudience("mcp").sign(new TextEncoder().encode("fixture"));
	await saveConfig({ token: "old", userId, oauth: { refreshToken: "refresh", expiresAt: 1 } }, home);
	const current = { ...await readConfig(home), graph: "acme/a" };
	const fetcher = (async () => Response.json({ access_token: token, refresh_token: "rotated", expires_in: 3600, scope: "memory:read memory:write" })) as typeof fetch;
	expect(await accessToken(home, current, fetcher)).toBe(token);
	expect(current.graph).toBe("acme/a");
	expect((await readConfig(home)).graph).toBeUndefined();
	expect(await accessToken(home, current, fetcher)).toBe(token);
	expect(current.graph).toBe("acme/a");
});

it("retains forbidden team uploads in that graph instead of retrying them as personal memory", async () => {
	const home = scratch(); await saveConfig({ token: "fixture" }, home);
	writeFileSync(join(home, ".loom.yml"), "graph: acme/forbidden\n");
	const graphs: Array<string | null> = [];
	const fetcher = (async (_url, init) => { graphs.push(new Headers(init?.headers).get("x-loom-graph")); return new Response("denied", { status: 403 }); }) as typeof fetch;
	const runtime = createRuntime(home, fetcher); cleanup.push(() => runtime.close());
	const { store } = await runtime.routing.select({ session: "denied", cwd: home });
	await handleHook(store, { session_id: "denied", hook_event_name: "Stop" }, fetcher);
	await runtime.pump(true);
	expect(graphs).toEqual(["acme/forbidden"]);
	expect(store.status()).toMatchObject({ queue: { events: 1 }, delivery: { failures: 1 } });
	expect((await runtime.routing.base()).status()).toMatchObject({ queue: { events: 0 } });
});
