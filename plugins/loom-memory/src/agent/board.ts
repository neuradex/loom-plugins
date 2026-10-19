import { isAbsolute, relative, resolve, sep } from "node:path";
import type { JsonRecord } from "./collector.js";
import { api, CredentialUnavailableError, DeliveryError } from "./delivery.js";
import { Store } from "./store.js";

/**
 * The working board, ported from Loom CLI's src/inquiry: questions the model opens
 * while it hunts for an answer, closed with what it found. A closed question lands
 * in the graph as knowledge (/ingest/inquiries, category "inquiry"), so the next
 * session gets the answer instead of repeating the hunt. An open question lands
 * too, unindexed, so the server's open-inquiry channel can show it as unresolved.
 *
 * The client never accumulates anything itself; it is only the producer. What this
 * host lacks compared to Loom CLI is a per-LLM-call tail: the board is injected
 * once per prompt (UserPromptSubmit) and, at most once per question, as a forced
 * follow-up turn when the model tries to stop with a hunted-but-unclosed question.
 */

export const BOARD_TAG_OPEN = "<loom.system.board>";
export const BOARD_TAG_CLOSE = "</loom.system.board>";
/** About 300 tokens. The block is re-read on every prompt; this is the rein. */
export const BUDGET_CHARS = 1200;
const LINE_MAX = 140;
const TITLE_MAX = 180;
/** Same ceiling as the server's `anchors: max(16)`; a longer list is a 400, which drops the landing. */
export const MAX_ANCHORS = 16;
/** Lower than the server ceiling so the model keeps room to narrow by hand. */
export const AUTO_GROUNDED_MAX = 8;
/** How long a landing waits for the turn's captured user message to be acknowledged
 * before it goes out without a grounding episode. A wrong turn's episode is worse
 * than none, so grounding is never guessed from an older acknowledgement. */
export const LANDING_GROUNDING_WAIT_MS = 60_000;
const SERVER_ANSWER_MAX = 32_000;

export type InquiryState = "open" | "resolved" | "abandoned";
export interface Inquiry {
	session: string; id: string; title: string; why: string | null; state: InquiryState; answer: string | null;
	grounded: string[]; anchors: string[]; ref: number | null; opened_at: number; closed_at: number | null;
	opened_seq: number; landed: string; landing_error: string | null; nudged: number;
}
export interface Todo { title: string; state: "pending" | "active" | "done" }
export interface BoardSnapshot { todos: Todo[]; inquiries: Inquiry[] }
export type CloseResult = { ok: true; item: Inquiry } | { ok: false; reason: "not_found" | "already_closed" | "empty_answer" };

interface Row { [key: string]: unknown }
const rowToInquiry = (row: Row): Inquiry => ({
	...(row as unknown as Inquiry),
	grounded: JSON.parse(String(row.grounded ?? "[]")) as string[],
	anchors: JSON.parse(String(row.anchors ?? "[]")) as string[],
});

function gist(value: unknown, max: number): string {
	const one = String(value ?? "").replace(/\s+/g, " ").trim();
	return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** The server's anchor grammar (nd-cloud anchors.ts): prefix, no whitespace, kebab rules. */
const ANCHOR_RE = /^(file|sym|err|rule):(\S+)$/;
function normalizeAnchors(raw: readonly unknown[] | undefined): string[] {
	const seen = new Set<string>();
	for (const value of raw ?? []) {
		const text = String(value ?? "").trim();
		if (text.length > 128) continue;
		const match = ANCHOR_RE.exec(text);
		if (!match || (match[1] === "rule" && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(match[2]!))) continue;
		seen.add(text);
		if (seen.size >= MAX_ANCHORS) break;
	}
	return [...seen];
}

// ── Touches: what the session actually opened, recorded by the client ─────────
// Grounding dictated by the model goes wrong twice: at open time it has not looked
// yet and invents symbols; at close time it retypes what the client already saw.
// Only tools that take one file path count; bash/grep/glob name search scopes,
// not files that were read.
const PATH_ARGS: Record<string, string> = {
	Read: "file_path", Edit: "file_path", Write: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path",
	read: "file_path", edit: "file_path", write: "file_path", str_replace: "path", create: "path",
};

/** `file:` anchors are repo-relative so one file is one node. Paths outside cwd are dropped. */
export function toRepoRelative(raw: unknown, cwd: string): string | null {
	if (typeof raw !== "string" || !raw.trim() || !isAbsolute(cwd)) return null;
	const absolute = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
	const rel = relative(resolve(cwd), absolute);
	if (!rel || rel === "." || rel.startsWith("..") || isAbsolute(rel)) return null;
	return rel.split(sep).join("/");
}

export function recordTouch(store: Store, session: string, toolName: unknown, toolInput: unknown, cwd: unknown): void {
	const key = PATH_ARGS[String(toolName ?? "")];
	if (!key || !toolInput || typeof toolInput !== "object" || typeof cwd !== "string") return;
	const file = toRepoRelative((toolInput as JsonRecord)[key], cwd);
	if (file) store.db.prepare("INSERT INTO touches(session,file) VALUES (?,?)").run(session, file);
}
function touchSeq(store: Store, session: string): number {
	return Number(store.db.prepare("SELECT COALESCE(MAX(seq),0) seq FROM touches WHERE session=?").get(session)?.seq ?? 0);
}
function touchedFiles(store: Store, session: string, afterSeq: number, limit: number): string[] {
	const rows = store.db.prepare("SELECT file FROM touches WHERE session=? AND seq>? ORDER BY seq DESC").all(session, afterSeq);
	return [...new Set(rows.map((row) => String(row.file)))].slice(0, limit);
}
function currentFile(store: Store, session: string): string | null {
	const row = store.db.prepare("SELECT file FROM touches WHERE session=? ORDER BY seq DESC LIMIT 1").get(session);
	return row ? String(row.file) : null;
}

// ── Ledger ─────────────────────────────────────────────────────────────────────
export function openInquiry(store: Store, session: string, question: string, why?: string): Inquiry {
	return store.transaction(() => {
		const count = Number(store.db.prepare("SELECT COUNT(*) n FROM inquiries WHERE session=?").get(session)!.n);
		const id = `q${count + 1}`;
		// Where the model stands when it asks: the last file it opened, not a symbol it guesses.
		const here = currentFile(store, session);
		const anchors = here ? [`file:${here}`] : [];
		store.db.prepare(`INSERT INTO inquiries(session,id,title,why,anchors,opened_at,opened_seq) VALUES (?,?,?,?,?,?,?)`)
			.run(session, id, gist(question, TITLE_MAX), why?.trim() ? gist(why, 2000) : null, JSON.stringify(anchors), Date.now(), touchSeq(store, session));
		return getInquiry(store, session, id)!;
	});
}
export function getInquiry(store: Store, session: string, id: string): Inquiry | undefined {
	const row = store.db.prepare("SELECT * FROM inquiries WHERE session=? AND id=?").get(session, id) as Row | undefined;
	return row ? rowToInquiry(row) : undefined;
}
export function closeInquiry(store: Store, session: string, id: string, input: { answer: string; grounded?: readonly unknown[] | undefined; status?: "resolved" | "abandoned" | undefined }): CloseResult {
	return store.transaction(() => {
		const item = getInquiry(store, session, id);
		if (!item) return { ok: false, reason: "not_found" };
		if (item.state !== "open") return { ok: false, reason: "already_closed" };
		const answer = String(input.answer ?? "").trim();
		if (!answer) return { ok: false, reason: "empty_answer" };
		// The model's narrowing wins: what was read and what settled the answer differ,
		// and only the reader knows the latter. Otherwise the files opened after the
		// question are the grounding; if none (a question registered after the hunt),
		// the most recent files are, so the costliest answers do not land ungrounded.
		const narrowed = normalizeAnchors(input.grounded);
		const since = touchedFiles(store, session, item.opened_seq, AUTO_GROUNDED_MAX);
		const auto = (since.length ? since : touchedFiles(store, session, 0, AUTO_GROUNDED_MAX)).map((file) => `file:${file}`);
		const grounded = narrowed.length ? narrowed : auto;
		store.db.prepare("UPDATE inquiries SET state=?,answer=?,grounded=?,closed_at=? WHERE session=? AND id=?")
			.run(input.status === "abandoned" ? "abandoned" : "resolved", answer.slice(0, SERVER_ANSWER_MAX), JSON.stringify(grounded), Date.now(), session, id);
		return { ok: true, item: getInquiry(store, session, id)! };
	});
}
export function openInquiries(store: Store, session: string): Inquiry[] {
	return (store.db.prepare("SELECT * FROM inquiries WHERE session=? AND state='open' ORDER BY opened_at").all(session) as Row[]).map(rowToInquiry);
}
export function snapshot(store: Store, session: string): BoardSnapshot {
	const todos = store.db.prepare("SELECT todos FROM board_todos WHERE session=?").get(session);
	return {
		todos: todos ? JSON.parse(String(todos.todos)) as Todo[] : [],
		inquiries: (store.db.prepare("SELECT * FROM inquiries WHERE session=? ORDER BY opened_at").all(session) as Row[]).map(rowToInquiry),
	};
}
/** The host's own task list (TodoWrite) is the plan; the board mirrors it rather than
 * asking the model to maintain a second one. */
export function mirrorTodos(store: Store, session: string, toolInput: unknown): void {
	const todos = (toolInput as JsonRecord | null)?.todos;
	if (!Array.isArray(todos)) return;
	const mapped: Todo[] = todos.map((todo): Todo => {
		const item = (todo ?? {}) as JsonRecord;
		const status = String(item.status ?? "pending");
		return { title: gist(item.content ?? item.title, TITLE_MAX), state: status === "completed" ? "done" : status === "in_progress" ? "active" : "pending" };
	}).filter((todo) => todo.title);
	store.db.prepare("INSERT OR REPLACE INTO board_todos(session,todos) VALUES (?,?)").run(session, JSON.stringify(mapped));
}

// ── Block ──────────────────────────────────────────────────────────────────────
// Measured in Loom CLI: the same opening instruction fired 0 times from the system
// prompt and immediately from the user-message position; after the user message
// 88%, before it 50%. UserPromptSubmit's additionalContext is the winning position.
const OPEN_TRIGGER = "About to grep or read around to settle something? Open it first: inquiry_open(\"...\") — then dig, and inquiry_close it yourself the moment you know.";

function fill(lines: string[], budget: number): { taken: string[]; dropped: number } {
	const taken: string[] = []; let used = 0;
	for (const line of lines) {
		if (used + line.length > budget && taken.length > 0) break;
		taken.push(line); used += line.length + 1;
	}
	return { taken, dropped: lines.length - taken.length };
}
/** Pure: the same snapshot renders the same bytes. Null when there is nothing to carry. */
export function renderBoardBlock(snap: BoardSnapshot, opts: { promptOpen?: boolean } = {}): string | null {
	const openTodos = snap.todos.filter((todo) => todo.state !== "done");
	const doneCount = snap.todos.length - openTodos.length;
	const open = snap.inquiries.filter((item) => item.state === "open");
	// Nudge to open only when nothing is open; asking again on top of a waiting question is noise.
	const promptOpen = opts.promptOpen === true && open.length === 0;
	if (openTodos.length === 0 && open.length === 0 && !promptOpen) return null;
	const todoLines = openTodos.map((todo) => `  ${todo.state === "active" ? "▸" : " "} ${gist(todo.title, LINE_MAX)}`);
	const inquiryLines = open.map((item) => `    ${item.id} ${gist(item.title, LINE_MAX)}${item.why ? ` — ${gist(item.why, 60)}` : ""}`);
	// Questions are the point of the board: reserve their share first, then let todos use the rest.
	const need = (lines: string[]) => lines.reduce((n, line) => n + line.length + 1, 0);
	const inquiryReserve = Math.min(need(inquiryLines), Math.floor(BUDGET_CHARS / 2));
	let spent = 0;
	const todoSection: string[] = [];
	if (openTodos.length) {
		const { taken, dropped } = fill(todoLines, BUDGET_CHARS - inquiryReserve);
		todoSection.push(`todo ${doneCount}/${snap.todos.length} done`, ...taken);
		if (dropped) todoSection.push(`    (+${dropped} more)`);
		spent = need(taken);
	}
	const inquirySection: string[] = [];
	if (open.length) {
		const { taken, dropped } = fill(inquiryLines, BUDGET_CHARS - spent);
		inquirySection.push(`open inquiries (${open.length})`, ...taken);
		if (dropped) inquirySection.push(`    (+${dropped} more — inquiry_list)`);
		inquirySection.push("Close one the moment you learn its answer: inquiry_close(id, answer, grounded). Do not carry an answered question into the next turn.");
	}
	const sections = [...inquirySection, ...todoSection];
	if (promptOpen) sections.push(OPEN_TRIGGER);
	return [BOARD_TAG_OPEN, ...sections, BOARD_TAG_CLOSE].join("\n");
}

// ── Hooks ──────────────────────────────────────────────────────────────────────
export interface BoardHookOutput { context?: string; decision?: "block"; reason?: string }

/** Runs inside capture.lock; touches SQLite only. Returns nothing for a session
 * without board state so hosts that do not use the board see no change. */
export function boardHook(store: Store, input: JsonRecord): BoardHookOutput {
	const event = String(input.hook_event_name ?? "");
	const session = String(input.session_id ?? "");
	if (!session) return {};
	if (event === "PreToolUse") recordTouch(store, session, input.tool_name, input.tool_input, input.cwd);
	if (event === "PostToolUse" && input.tool_name === "TodoWrite") mirrorTodos(store, session, input.tool_input);
	if (event === "UserPromptSubmit") {
		const block = renderBoardBlock(snapshot(store, session), { promptOpen: touchSeq(store, session) > 0 });
		return block ? { context: block } : {};
	}
	if (event === "Stop" && input.stop_hook_active !== true) {
		// A question that was hunted after it was opened and is still open when the
		// turn ends is probably answered in the model's head. One forced follow-up
		// per question asks for the close; a question kept open on purpose survives
		// the session, which is the open-inquiry channel's job.
		const hunted = openInquiries(store, session).filter((item) => !item.nudged && touchedFiles(store, session, item.opened_seq, 1).length > 0);
		if (hunted.length) {
			store.transaction(() => { for (const item of hunted) store.db.prepare("UPDATE inquiries SET nudged=1 WHERE session=? AND id=?").run(session, item.id); });
			const list = hunted.map((item) => `${item.id} "${gist(item.title, 80)}"`).join(", ");
			return { decision: "block", reason: `Open Loom inquiries you dug into are still unanswered: ${list}. If you learned the answer, call inquiry_close(id, answer) now so the next session skips your hunt; if you could not settle it, close it with status "abandoned" and what you ruled out; if it must stay open across sessions, say so in one line and finish.` };
		}
	}
	if (event === "SessionEnd") store.db.prepare("DELETE FROM touches WHERE session=?").run(session);
	return {};
}

// ── Landing ────────────────────────────────────────────────────────────────────
interface Grounding { id: number; at: number }
/** The captured user message that preceded the question, once the server acknowledged it. */
export function groundingKey(session: string): string { return `userEpisode:${session}`; }

/** Opened questions land once as `open`; a close updates the same row. Sending a
 * second insert would split one question into an open row and a closed row, and
 * the open-inquiry channel would hold an answered question forever. */
export async function deliverBoard(store: Store, fetcher = fetch): Promise<void> {
	if (store.get("boardRetryAt", 0) > Date.now()) return;
	const pending = (store.db.prepare("SELECT * FROM inquiries WHERE landed<>state AND landing_error IS NULL ORDER BY opened_at, closed_at").all() as Row[]).map(rowToInquiry);
	for (const item of pending) {
		const eventAt = item.state === "open" ? item.opened_at : item.closed_at ?? item.opened_at;
		const queued = store.db.prepare("SELECT 1 FROM outbox WHERE segment IN (SELECT segment FROM sources WHERE session=?) LIMIT 1").get(item.session);
		if (queued && Date.now() < eventAt + LANDING_GROUNDING_WAIT_MS) continue;
		const grounding = store.get<Grounding | null>(groundingKey(item.session), null);
		const groundedBy = grounding && grounding.at <= eventAt ? [grounding.id] : [];
		const anchors = normalizeAnchors(item.state === "open" ? item.anchors : [...item.grounded, ...item.anchors]);
		const body = {
			question: item.title, status: item.state,
			...(item.ref ? { id: item.ref } : {}),
			...(item.why ? { why: item.why } : {}),
			...(item.answer ? { answer: item.answer } : {}),
			...(anchors.length ? { anchors } : {}),
			...(groundedBy.length ? { grounded_by: groundedBy } : {}),
			// Open and close must differ; the same key would hand the close the open's idempotent reply.
			idempotency_key: `inquiry:${item.session}:${item.id}:${item.opened_at}:${item.state === "open" ? "open" : "close"}`,
		};
		try {
			const result = await api<{ ok?: boolean; id?: number }>(store, "/ingest/inquiries", body, fetcher);
			if (!result?.ok || typeof result.id !== "number") throw new Error("Loom did not acknowledge the inquiry.");
			store.db.prepare("UPDATE inquiries SET ref=?,landed=? WHERE session=? AND id=?").run(result.id, item.state, item.session, item.id);
		} catch (error) {
			// A request the server rejects outright will be rejected again; keep the
			// ledger row, record the classification and stop retrying it. Anything
			// else (network, 401, 429, 5xx) backs off and is retried in order.
			if (error instanceof DeliveryError && [400, 404, 413, 422].includes(error.status)) {
				store.db.prepare("UPDATE inquiries SET landing_error=? WHERE session=? AND id=?").run(error.message, item.session, item.id);
				continue;
			}
			const denied = error instanceof CredentialUnavailableError || error instanceof DeliveryError && [401, 403].includes(error.status);
			store.set("boardRetryAt", Date.now() + (denied ? 300_000 : Math.max(15_000, error instanceof DeliveryError ? error.retryAfterMs : 0)));
			return;
		}
	}
}
