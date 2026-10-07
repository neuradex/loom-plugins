import type { Project } from "./project.js";
import type { Store } from "./store.js";

/** What a session is told about Loom when it starts. The hook injects nothing
 * else at this point when the collector is connected, so the model's first
 * contact with Loom used to be a recall block that opens with a caution. People
 * meanwhile had no way to see which graph a session writes to: "is this even
 * running?" sessions are a recurring topic in the memory itself. */
export interface SessionOrientation { additionalContext: string; systemMessage?: string }
interface Settings { notifications: { session_start: boolean; recall_errors?: boolean } }
const DAY = 86_400_000;

export function ago(ms: number): string {
	if (ms < 60_000) return "just now";
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
	if (ms < DAY) return `${Math.floor(ms / 3_600_000)} h ago`;
	return `${Math.floor(ms / DAY)} d ago`;
}

export function sessionOrientation(store: Store, project: Project | undefined, settings: Settings, now = Date.now()): SessionOrientation {
	const graph = store.config.graph ?? "personal";
	const file = project?.file ?? null;
	// Subagent sources carry the parent's id plus ":agent:"; count host sessions once.
	const sessions = (store.db.prepare("SELECT count(DISTINCT session) n FROM sources WHERE last_seen > ? AND session NOT LIKE '%:agent:%'")
		.get(now - DAY) as { n: number }).n;
	const queued = (store.db.prepare("SELECT count(*) n FROM outbox").get() as { n: number }).n;
	const delivery = store.get<{ lastSuccess: number }>("delivery", { lastSuccess: 0 });
	const upload = delivery.lastSuccess ? `last upload ${ago(now - delivery.lastSuccess)}` : "no upload yet";
	const recall = store.get<{ status: string; lastSuccessAt?: number; lastFailureAt?: number; lastError?: { kind: string } }>("recall", { status: "not_attempted" });
	const recallLine = recall.status === "ok" ? `ok (${ago(now - (recall.lastSuccessAt ?? now))})`
		: recall.status === "unavailable" ? `unavailable since ${ago(now - (recall.lastFailureAt ?? now))}${recall.lastError ? ` (${recall.lastError.kind})` : ""}`
		: "not attempted yet";
	const captured = `${sessions} session${sessions === 1 ? "" : "s"} captured`;
	const systemMessage = `Loom → ${graph}${file ? " (.loom.yml)" : ""} · last 24h: ${captured} · ${upload} · queue ${queued} · recall ${recallLine}`;
	const additionalContext = [
		`Loom memory for this session — graph: ${graph}${file ? `, pinned by ${file}` : " (no .loom.yml; the person's personal memory)"}.`,
		`Capture is automatic through hooks: ${captured} in the last 24 h, ${upload}, ${queued} queued; nothing needs to be saved by hand.`,
		"Recall arrives with each prompt as cards (ref, kind, date, snippet) under a receipt; read a card's full text with memory_read and call report_memory_use before finishing.",
		"Graph tools on this server: memory_status, list_graphs, switch_graph, create_graph — or /loom-memory:graph, /loom-memory:switch, /loom-memory:create. The remote `loom` server searches the same memory directly (search, fetch, remember).",
	].join("\n");
	return settings.notifications.session_start ? { additionalContext, systemMessage } : { additionalContext };
}
