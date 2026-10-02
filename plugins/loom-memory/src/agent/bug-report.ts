import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { accessToken } from "./auth.js";
import type { Scope } from "./routing.js";
import type { Store } from "./store.js";

const VERSION = "0.4.0";
const MAX_TRANSCRIPT_BYTES = 1536 * 1024;
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const scopeArgs = {
	receipt: z.string().uuid().optional().describe("Loom receipt identifying the affected session and graph."),
	cwd: z.string().optional().describe("Absolute project directory when no receipt is available."),
	session_id: z.string().min(1).max(200).optional().describe("Host session ID when no receipt is available. Required to attach its registered transcript."),
};
interface Draft { payload: string; state: string; result: string | null; expires: number }

// Like the CLI reporter, preserve protocol/tool evidence and redact credentials only.
function scrub(text: string, store: Store): { text: string; redactions: number } {
	let redactions = 0;
	for (const secret of [store.config.token, store.config.oauth?.refreshToken]) {
		if (secret) text = text.split(secret).map((part, index) => { if (index) redactions++; return part; }).join("[redacted]");
	}
	for (const pattern of [
		/\bloom_sk_[A-Za-z0-9_-]{8,}/g, /\bsk-[A-Za-z0-9_-]{16,}/g,
		/\bgh[pousr]_[A-Za-z0-9]{16,}/g, /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
		/\bAKIA[0-9A-Z]{16}\b/g, /\bAIza[0-9A-Za-z_-]{20,}/g,
		/\bBearer\s+[A-Za-z0-9._-]{8,}/gi,
		/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
	]) text = text.replace(pattern, () => { redactions++; return "[redacted]"; });
	return { text, redactions };
}

/** Read only the selected registered session, with bounded allocation even for huge logs.
 * Keep complete JSONL records from the tail; an incomplete last record is not evidence yet. */
async function transcript(store: Store, session: string) {
	const sources = store.sources().filter(source => source.session === session && source.path && !source.sealed);
	if (sources.length !== 1) throw new Error("No unique registered transcript for this session. Prepare without an attachment or pass the correct receipt/session_id.");
	const file = await open(sources[0]!.path, "r").catch(() => { throw new Error("The registered transcript cannot be read. Prepare without an attachment."); });
	try {
		const size = (await file.stat()).size;
		const start = Math.max(0, size - MAX_TRANSCRIPT_BYTES);
		const buffer = Buffer.alloc(Math.min(size, MAX_TRANSCRIPT_BYTES));
		let read = 0;
		while (read < buffer.length) {
			const result = await file.read(buffer, read, buffer.length - read, start + read);
			if (!result.bytesRead) break;
			read += result.bytesRead;
		}
		const bytes = buffer.subarray(0, read);
		const first = start ? bytes.indexOf(10) + 1 : 0;
		const last = bytes.lastIndexOf(10);
		const lines = (last >= first && (!start || first) ? bytes.subarray(first, last).toString("utf8") : "").split("\n").filter(Boolean);
		const kept: string[] = []; let used = 0; let redactions = 0;
		for (let i = lines.length - 1; i >= 0; i--) {
			try { JSON.parse(lines[i]!); } catch { throw new Error("The session contains invalid JSONL. Prepare without an attachment; its source is unchanged."); }
			const clean = scrub(lines[i]!, store);
			const cost = Buffer.byteLength(clean.text) + (kept.length ? 1 : 0);
			if (used + cost > MAX_TRANSCRIPT_BYTES) break;
			kept.push(clean.text); used += cost; redactions += clean.redactions;
		}
		if (size && !kept.length) throw new Error("No complete transcript record fits the attachment limit. Prepare without an attachment.");
		return { text: kept.reverse().join("\n") || null, lines: kept.length, bytes: used, redactions,
			truncated: start > 0 || last !== read - 1 || read !== size || kept.length !== lines.length };
	} finally { await file.close(); }
}

export function registerBugReportTools(server: McpServer, getStore: (scope: Scope) => Promise<Store>, fetcher = fetch): void {
	const json = (value: unknown, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], ...(isError ? { isError } : {}) });
	const run = async (scope: Scope, fn: (store: Store) => Promise<unknown>) => {
		try { return json(await fn(await getStore(scope))); }
		catch (error) { return json({ error: error instanceof Error && error.name === "Error" ? error.message : "Bug report preparation failed. Check memory_status and retry preparation." }, true); }
	};
	server.registerTool("prepare_bug_report", {
		description: "Prepare a Loom bug report requested by the user, like CLI /bug-report. Collects plugin/host diagnostics and optionally this session's registered transcript. Redacts known credentials and returns a frozen local draft with an exact preview; nothing is uploaded. Show the report and attachment summary to the user before submit_bug_report. Diagnostics are support data, not memories.",
		inputSchema: { ...scopeArgs, title: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(20_000),
			model: z.string().max(200).optional(), include_transcript: z.boolean().default(false) },
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
	}, ({ receipt, cwd, session_id, title, body, model, include_transcript }) => run({ receipt, cwd, session: session_id }, async store => {
		const row = receipt ? store.db.prepare("SELECT session FROM receipts WHERE id=?").get(receipt) : undefined;
		if (receipt && !row) throw new Error("Receipt not found in this account/graph. Pass the affected session's receipt.");
		if (row && session_id && row.session !== session_id) throw new Error("Receipt and session_id refer to different sessions.");
		const session = row?.session as string | undefined ?? session_id;
		if (include_transcript && !session) throw new Error("Attaching a transcript requires a receipt or host session_id.");
		const attachment = include_transcript ? await transcript(store, session!) : { text: null, lines: 0, bytes: 0, truncated: false, redactions: 0 };
		const clean = scrub(JSON.stringify({ title, body, client_version: VERSION, platform: `${platform()} ${arch()} ${release()}`, model,
			session_id: session, diagnostics: { client: "loom-memory-plugin", node: process.version, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				graph: store.config.graph ?? "personal", gateway_url: store.config.url, capture_enabled: store.config.capture, recall_enabled: store.config.recall,
				status: store.status() } }), store);
		const payload = { ...JSON.parse(clean.text), transcript: attachment.text, transcript_lines: attachment.lines, transcript_truncated: attachment.truncated };
		if (session && session.length > 200) throw new Error("Host session ID exceeds the report API limit.");
		if (Buffer.byteLength(JSON.stringify(payload.diagnostics)) > 64 * 1024) throw new Error("Diagnostics exceed the report API limit.");
		const draft_id = randomUUID(); const expires = Date.now() + DRAFT_TTL_MS;
		store.transaction(() => {
			store.db.prepare("DELETE FROM bug_report_drafts WHERE expires < ?").run(Date.now());
			store.db.prepare("INSERT INTO bug_report_drafts(id,payload,state,expires) VALUES (?,?,'prepared',?)").run(draft_id, JSON.stringify(payload), expires);
		});
		const { transcript: _transcript, ...preview } = payload;
		return { draft_id, expires_at: new Date(expires).toISOString(), destination: `${store.config.url}/bug-reports`, preview,
			attachment: { included: attachment.text !== null, lines: attachment.lines, bytes: attachment.bytes, truncated: attachment.truncated },
			redactions: clean.redactions + attachment.redactions, next: "Show this preview to the user. After approval, submit this draft_id with the same receipt or project/session scope. To change the report or attachment, prepare a new draft." };
	}));
	server.registerTool("submit_bug_report", {
		description: "Send the exact frozen draft from prepare_bug_report to Loom support after the user approves its preview and attachment. Pass the draft's original receipt or project/session scope. Returns the report ID. An uncertain delivery is never retried automatically; inspect support records before preparing a replacement.",
		inputSchema: { ...scopeArgs, draft_id: z.string().uuid() },
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
	}, async ({ receipt, cwd, session_id, draft_id }) => {
		let store: Store;
		try { store = await getStore({ receipt, cwd, session: session_id }); }
		catch { return json({ error: "Report account/graph unavailable. Reconnect Loom or pass the draft's original scope." }, true); }
		const draft = store.db.prepare("SELECT * FROM bug_report_drafts WHERE id=?").get(draft_id) as unknown as Draft | undefined;
		if (!draft || draft.expires < Date.now()) return json({ error: "Draft missing or expired. Prepare a fresh preview." }, true);
		if (draft.state === "sent") return json(JSON.parse(draft.result!));
		if (draft.state !== "prepared") return json({ error: "delivery_unknown", message: "This draft was already attempted. It may have reached support; do not resend blindly." }, true);
		let token: string;
		try { token = await accessToken(store.home, store.config, fetcher); }
		catch { return json({ error: "authentication_required", message: "Reconnect Loom and submit this draft again. Nothing was sent." }, true); }
		// Claim before the network hop, across processes. A crash cannot replay a POST.
		const claimed = store.db.prepare("UPDATE bug_report_drafts SET state='attempted' WHERE id=? AND state='prepared'").run(draft_id);
		if (!claimed.changes) return json({ error: "already_attempted" }, true);
		try {
			const response = await fetcher(`${store.config.url}/bug-reports`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: draft.payload, redirect: "error", signal: AbortSignal.timeout(30_000) });
			// These statuses explicitly reject admission, so retrying the same preview is safe.
			if ([400, 401, 403, 413, 429].includes(response.status)) {
				store.db.prepare("UPDATE bug_report_drafts SET state='prepared' WHERE id=?").run(draft_id);
				const reason = { 400: "invalid_request", 401: "authentication_required", 403: "permission_denied", 413: "report_too_large", 429: "too_many_reports" }[response.status];
				return json({ error: reason, status: response.status, message: "Report rejected. The draft is retained. Check authentication/server support or limits before retrying." }, true);
			}
			const result = z.object({ ok: z.literal(true), id: z.string().uuid(), created_at: z.string().datetime() }).safeParse(await response.json());
			if (!response.ok || !result.success) throw new Error("Uncertain response");
			store.db.prepare("UPDATE bug_report_drafts SET state='sent',result=? WHERE id=?").run(JSON.stringify(result.data), draft_id);
			return json(result.data);
		} catch {
			return json({ error: "delivery_unknown", message: "Support may have received the report, but no valid receipt arrived. No automatic retry; check support records before resending." }, true);
		}
	});
}
