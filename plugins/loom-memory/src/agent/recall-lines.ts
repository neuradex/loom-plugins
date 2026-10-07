/** Compact recall cards — what the prompt hook injects per candidate.
 *
 * The server's candidate lines are full renders: a topic carries its tag list and
 * embedded messages, an episode carries the whole captured transcript record as
 * JSON (1.7–17 KB each in production). Injected verbatim under the block budget
 * they left room for three or four lines, and the answer was often the eleventh.
 * A card keeps what the model needs to decide whether to read more — ref, kind,
 * date, title and a short snippet of spoken text — so every ranked candidate
 * fits. The full text is one memory_read away. */
export const RECALL_BLOCK_CHARS = 8_000;
export const RECALL_SNIPPET_CHARS = 300;

export interface RecallCard { ref: string; line: string }
type Kind = "knowledge" | "topic" | "episode";
const PREFIX: Record<Kind, string> = { knowledge: "kn", topic: "tp", episode: "ep" };
const SPOKEN_TYPES = new Set(["text", "input_text", "output_text"]);

function unescapeXml(s: string): string {
	return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}
function attr(attrs: string, name: string): string | undefined {
	return new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];
}
function squash(s: string): string { return s.replace(/\s+/g, " ").trim(); }
function snippet(s: string, max: number): string {
	const text = squash(s);
	if (text.length <= max) return text;
	const cut = text.lastIndexOf(" ", max);
	return `${text.slice(0, cut > max * 0.6 ? cut : max).trimEnd()}…`;
}

/** The spoken text of a captured transcript record (Claude Code `message` or Codex
 * `payload`), or null when the record carries none: hook observations, tool
 * calls, tool results and session metadata are not something to recall. */
export function spokenText(record: unknown): string | null {
	if (!record || typeof record !== "object") return null;
	const r = record as Record<string, unknown>;
	const message = (r.message ?? r.payload) as Record<string, unknown> | undefined;
	if (!message || typeof message !== "object") return null;
	const content = message.content;
	if (typeof content === "string") return content.trim() || null;
	if (!Array.isArray(content)) return null;
	const parts = content.flatMap((item) => {
		if (!item || typeof item !== "object") return [];
		const { type, text } = item as { type?: unknown; text?: unknown };
		return typeof text === "string" && SPOKEN_TYPES.has(String(type)) ? [text] : [];
	});
	return parts.join(" ").trim() || null;
}

/** One server candidate line → one card, or null when it is not a recallable
 * knowledge/topic/episode line or carries no readable text. */
export function compactCandidateLine(line: string, snippetChars = RECALL_SNIPPET_CHARS): RecallCard | null {
	const m = /^\s*<(knowledge|topic|episode)\b([^>]*)>([\s\S]*?)<\/\1>\s*$/.exec(line);
	if (!m) return null;
	const kind = m[1] as Kind; const attrs = m[2]!; const inner = m[3]!;
	const id = attr(attrs, "id");
	if (!id || !/^\d+$/.test(id)) return null;
	const ref = `${PREFIX[kind]}:${id}`;
	const date = attr(attrs, "date") ?? attr(attrs, "last") ?? "";
	if (kind === "topic") {
		const title = squash(unescapeXml(/<title>([\s\S]*?)<\/title>/.exec(inner)?.[1] ?? ""));
		const summary = unescapeXml(/<summary>([\s\S]*?)<\/summary>/.exec(inner)?.[1] ?? "");
		const body = [title, snippet(summary, snippetChars)].filter(Boolean).join(" — ");
		return body ? { ref, line: `${[ref, kind, date].filter(Boolean).join(" ")} · ${body}` } : null;
	}
	if (kind === "knowledge") {
		const body = snippet(unescapeXml(inner), snippetChars);
		return body ? { ref, line: `${[ref, kind, date].filter(Boolean).join(" ")} · ${body}` } : null;
	}
	const raw = unescapeXml(inner).trim();
	let text: string | null = raw;
	if (raw.startsWith("{")) {
		try { text = spokenText(JSON.parse(raw)); } catch { text = raw; }
	}
	if (!text) return null;
	return { ref, line: `${[ref, kind, attr(attrs, "role"), date].filter(Boolean).join(" ")} · ${snippet(text, snippetChars)}` };
}

/** Cards for a /retrieve result, in server rank order, within the block budget.
 * Only refs the server lists as candidates are offered (they are what
 * report_memory_use may later pick). A card that no longer fits ends the block;
 * the first card is cut rather than dropped so the block is never empty. */
export function buildRecallBlock(
	result: { candidate_lines: unknown[]; candidates: Array<{ ref: string; label?: string }> },
	options: { blockChars?: number; snippetChars?: number } = {},
): { lines: string[]; offered: string[] } {
	const allowed = new Set(result.candidates.map((candidate) => candidate.ref));
	const lines: string[] = []; const offered: string[] = [];
	let remaining = options.blockChars ?? RECALL_BLOCK_CHARS;
	for (const line of result.candidate_lines) {
		if (typeof line !== "string") continue;
		if (remaining < 100) break;
		const card = compactCandidateLine(line, options.snippetChars);
		if (!card || !allowed.has(card.ref)) continue;
		let shown = card.line;
		if (shown.length + 1 > remaining) {
			if (lines.length) break;
			shown = `${shown.slice(0, remaining - 2)}…`;
		}
		lines.push(shown); offered.push(card.ref); remaining -= shown.length + 1;
	}
	return { lines, offered };
}
