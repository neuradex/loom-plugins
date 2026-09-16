import { openSync, closeSync, fstatSync, readSync } from "node:fs";
import { digest } from "./config.js";
import { Store, type Episode, type Source } from "./store.js";

const READ_BYTES = 1_048_576;
const MAX_RECORD_BYTES = 16_777_216;
export type JsonRecord = Record<string, unknown>;
const object = (value: unknown): JsonRecord => value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};

function outcome(value: unknown): JsonRecord {
	if (typeof value === "string") { try { value = JSON.parse(value); } catch { return { outcomeUnknown: true }; } }
	const result = object(value);
	if (typeof result.isError === "boolean") return { isError: result.isError };
	if (typeof result.is_error === "boolean") return { isError: result.is_error };
	if (typeof result.exit_code === "number") return { isError: result.exit_code !== 0 };
	return { outcomeUnknown: true };
}

export function actorOf(record: JsonRecord): Episode["actor_type"] {
	if (record.type === "hook_observation") {
		if (record.hook_event_name === "UserPromptSubmit") return "user";
		if (["Stop", "SubagentStop"].includes(String(record.hook_event_name)) && record.last_assistant_message) return "assistant";
		if (record.hook_event_name === "PostToolUse") return "tool";
		if (record.hook_event_name === "PreToolUse") return "assistant";
	}
	const message = object(record.message);
	if (Array.isArray(message.content) && message.content.length > 0 && message.content.every((part) => object(part).type === "tool_result")) return "tool";
	const payload = object(record.payload);
	const type = String(payload.type ?? "");
	if (["function_call_output", "custom_tool_call_output"].includes(type)) return "tool";
	if (["function_call", "custom_tool_call"].includes(type)) return "assistant";
	const role = message.role ?? (record.type === "response_item" ? payload.role : undefined);
	if (role === "user" || role === "assistant" || role === "tool") return role;
	return "system";
}

/** Match the existing episode renderer's vocabulary. Unknown/audit records stay
 * stored, but must not be indexed as conversational memories. */
export function shapeOf(record: JsonRecord): { type: string; metadata: JsonRecord } {
	if (record.type === "hook_observation" && ["PreToolUse", "PostToolUse"].includes(String(record.hook_event_name))) {
		return { type: record.hook_event_name === "PreToolUse" ? "tool_call" : "tool_result", metadata: {
			id: record.tool_use_id, toolUseId: record.tool_use_id, toolName: record.tool_name,
			...(record.hook_event_name === "PostToolUse" ? outcome(record.tool_response) : {}),
		} };
	}
	const message = object(record.message);
	const payload = object(record.payload);
	const blocks = Array.isArray(message.content) ? message.content.map(object) : [];
	const tool = blocks.length === 1 ? blocks[0] : undefined;
	const toolType = tool?.type ?? payload.type;
	if (toolType === "tool_use" || toolType === "function_call" || toolType === "custom_tool_call") {
		const id = tool?.id ?? payload.call_id;
		const name = tool?.name ?? payload.name;
		let input = tool?.input ?? payload.arguments ?? payload.input;
		if (typeof input === "string") {
			const rawInput = input;
			try { input = JSON.parse(rawInput); } catch { input = { description: rawInput.slice(0, 200) }; }
		}
		const hints = Object.fromEntries(Object.entries(object(input)).filter(([key, value]) =>
			["description", "command", "path", "file_path", "url", "query", "pattern"].includes(key) && typeof value === "string")
			.map(([key, value]) => [key, (value as string).slice(0, 200)]));
		return { type: "tool_call", metadata: { id, toolName: name, input: hints } };
	}
	if (toolType === "tool_result" || toolType === "function_call_output" || toolType === "custom_tool_call_output") {
		return { type: "tool_result", metadata: { toolUseId: tool?.tool_use_id ?? payload.call_id,
			...(tool ? { isError: tool.is_error === true } : outcome(payload.output)),
		} };
	}
	if (toolType === "reasoning" || (blocks.length > 0 && blocks.every((block) => ["thinking", "redacted_thinking"].includes(String(block.type))))) {
		return { type: "thinking", metadata: {} };
	}
	return { type: actorOf(record) === "system" ? "capture_record" : "message", metadata: {} };
}

/** The raw JSONL record is the evidence. Unknown record types are retained rather
 * than silently lost when a host adds fields/events. No LLM selects what to keep. */
export function appendRecord(store: Store, source: Source, raw: string, offset: number, origin = "transcript"): void {
	let record: JsonRecord;
	try { record = object(JSON.parse(raw)); }
	catch { throw new Error(`Invalid JSONL at byte ${offset}; cursor retained for recovery.`); }
	const sourceEvent = typeof record.uuid === "string" ? record.uuid : record.ordinal ?? offset;
	const id = digest(JSON.stringify([source.id, origin, sourceEvent, raw]));
	const shape = shapeOf(record);
	// Bound the serialized HTTP request, including worst-case JSON escaping. Split
	// without dropping bytes, and retain reconstruction metadata for each raw record.
	const width = Math.max(128, Math.floor((store.config.batchBytes - 8192) / 12));
	const parts: string[] = [];
	for (let start = 0; start < raw.length;) {
		let end = Math.min(raw.length, start + width);
		if (end < raw.length && /[\uD800-\uDBFF]/.test(raw[end - 1]!)) end--;
		parts.push(raw.slice(start, end)); start = end;
	}
	const timestamp = typeof record.timestamp === "string" && Number.isFinite(Date.parse(record.timestamp))
		? { created_at: new Date(record.timestamp).toISOString() } : {};
	for (const [index, part] of parts.entries()) {
		store.append(source, {
			idempotency_key: `agent:${id}:${index}`,
			actor_type: actorOf(record), type: shape.type, content: part,
			metadata: {
				...shape.metadata,
				capture_origin: origin, source_session_id: source.session,
				source_id: source.id, source_offset: offset, record_id: id,
				record_type: String(record.type ?? "unknown"), part: index + 1, parts: parts.length,
			},
			...timestamp,
		});
	}
}

/** Reads a bounded prefix, ending only at a complete JSONL line. Source offsets
 * and all outbox inserts commit together; retrying a killed collector is safe. */
export function collect(store: Store, sourceId: string): number {
	let count = 0;
	try {
		store.transaction(() => {
			const source = store.db.prepare("SELECT * FROM sources WHERE id=?").get(sourceId) as unknown as Source;
			if (!source.path) return;
			const fd = openSync(source.path, "r");
			try {
				const stat = fstatSync(fd);
				if (!stat.isFile()) throw new Error("Transcript path is not a regular file.");
				const identity = `${stat.dev}:${stat.ino}`;
				let offset = identity !== source.identity || stat.size < source.offset ? 0 : source.offset;
				const tailHash = (position: number): string => {
					const tail = Buffer.alloc(Math.min(64, position));
					readSync(fd, tail, 0, tail.length, position - tail.length);
					return digest(tail.toString("base64"));
				};
				// A file can be truncated and regrow between polls without changing its
				// inode. Check the old cursor's tail before trusting that byte offset.
				if (offset && source.tail_hash && tailHash(offset) !== source.tail_hash) offset = 0;
				if (stat.size === offset) {
					store.db.prepare("UPDATE sources SET error=NULL WHERE id=?").run(source.id);
					return;
				}
				let bytes = Math.min(READ_BYTES, stat.size - offset);
				let buffer: Buffer;
				let end: number;
				do {
					buffer = Buffer.alloc(bytes);
					const read = readSync(fd, buffer, 0, bytes, offset);
					buffer = buffer.subarray(0, read);
					end = buffer.lastIndexOf(10);
					if (end >= 0 || bytes >= stat.size - offset || bytes >= MAX_RECORD_BYTES) break;
					bytes = Math.min(bytes * 2, MAX_RECORD_BYTES, stat.size - offset);
				} while (true);
				if (end < 0) {
					store.db.prepare("UPDATE sources SET error=? WHERE id=?").run(
						bytes >= MAX_RECORD_BYTES ? "Record exceeds 16 MiB; source retained, manual recovery required." : "Waiting for a complete JSONL line.", source.id);
					return;
				}
				let start = 0;
				while (start <= end && count < 500) {
					const newline = buffer.indexOf(10, start);
					const raw = buffer.subarray(start, newline).toString("utf8").replace(/\r$/, "");
					if (raw.length) { appendRecord(store, source, raw, offset + start); count++; }
					start = newline + 1;
				}
				offset += start;
				store.db.prepare("UPDATE sources SET offset=?,identity=?,tail_hash=?,error=? WHERE id=?")
					.run(offset, identity, tailHash(offset), offset < stat.size ? "Catching up with transcript." : null, source.id);
			} finally { closeSync(fd); }
		});
	} catch (error) {
		store.db.prepare("UPDATE sources SET error=? WHERE id=?").run(
			error instanceof Error ? error.message : "Capture failed; cursor retained.", sourceId);
		throw error;
	}
	return count;
}

export function collectAll(store: Store): void {
	// Fair bounded polling prevents long-lived accounts with many registered
	// transcripts from monopolizing the uploader lease or one event-loop tick.
	const cursor = store.get("sourcePollCursor", "");
	let sources = store.db.prepare("SELECT * FROM sources WHERE id>? ORDER BY id LIMIT 32").all(cursor) as unknown as Source[];
	if (!sources.length) sources = store.db.prepare("SELECT * FROM sources ORDER BY id LIMIT 32").all() as unknown as Source[];
	for (const source of sources) {
		try { collect(store, source.id); }
		catch { /* Each source retains its own error and cursor; other sessions can progress. */ }
	}
	if (sources.length) store.set("sourcePollCursor", sources.at(-1)!.id);
}
