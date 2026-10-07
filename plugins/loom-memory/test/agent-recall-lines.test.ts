import { describe, expect, it } from "vitest";
import { buildRecallBlock, compactCandidateLine, RECALL_BLOCK_CHARS, RECALL_SNIPPET_CHARS } from "../src/agent/recall-lines.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Shapes copied from real /retrieve candidate lines (render.ts): the server XML-escapes episode content. */
const claudeAssistant = (id: number, text: string) => `<episode id="${id}" role="assistant" session="agent:abc" date="2026-10-05" datetime="2026-10-05T14:30:00.000Z" distance="0.630" kw="5" score="0.98">\n${esc(JSON.stringify({
	parentUuid: "6b3cce5c", isSidechain: false, message: { model: "claude-fable-5-1", id: "msg_1", type: "message", role: "assistant",
		content: [{ type: "text", text }], usage: { input_tokens: 2 } }, uuid: "u1", timestamp: "2026-10-05T14:30:00.000Z" }))}\n</episode>`;
const claudeUser = (id: number, text: string) => `<episode id="${id}" role="user" date="2026-10-06" distance="0.698" kw="3" score="0.96">\n${esc(JSON.stringify({
	parentUuid: "c4aa", type: "user", message: { role: "user", content: text }, uuid: "u2", permissionMode: "bypassPermissions" }))}\n</episode>`;
const codexAssistant = (id: number, text: string) => `<episode id="${id}" role="assistant" date="2026-09-16" distance="0.695" kw="5" score="0.96">\n${esc(JSON.stringify({
	timestamp: "2026-09-16T18:05:04.472Z", ordinal: 1722, type: "response_item",
	payload: { type: "message", id: "msg_x", role: "assistant", content: [{ type: "output_text", text }] } }))}\n</episode>`;
const hookObservation = (id: number) => `<episode id="${id}" role="user" date="2026-10-05" distance="0.872" kw="3" score="0.92">\n${esc(JSON.stringify({
	type: "hook_observation", timestamp: "2026-10-05T14:30:22.510Z", session_id: "da759706", transcript_path: "/x.jsonl", cwd: "/w", hook_event_name: "PostToolUse" }))}\n</episode>`;
const toolResult = (id: number) => `<episode id="${id}" role="tool" date="2026-10-05" distance="0.9" kw="1" score="0.5">\n${esc(JSON.stringify({
	type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "exit 0" }] } }))}\n</episode>`;
const legacyEpisode = (id: number, text: string) => `<episode id="${id}" role="assistant" session="2026-07-28T18-53-59" date="2026-07-28" distance="0.703" kw="2" score="1.10">\n${esc(text)}\n</episode>`;
const topic = (id: number, title: string, summary: string) => `<topic id="${id}" distance="0.669" kw="3" tag="2" score="1.10" last="2026-10-01" tags="${"loom,memory,orgai-inc,agent:a996f8f4-2d08-487d-ba2c-758f3c3ffd3b,".repeat(6)}캡처 큐">\n<title>${esc(title)}</title>\n<summary>${esc(summary)}</summary>\n<episodes>\n<message id="117152" role="agent" session="agent:193a" date="2026-10-01">${esc(JSON.stringify({ payload: { content: [{ type: "output_text", text: "embedded message that must not leak" }] } }))}</message>\n</episodes>\n</topic>`;
const knowledge = (id: number, body: string) => `<knowledge id="${id}" date="2026-10-05" by="extracted" kind="fact" tags="loom,plugin,잠금" distance="0.661" kw="3" score="1.10">\n${esc(body)}\n</knowledge>`;

describe("compact recall cards", () => {
	it("turns a knowledge line into one card with ref, kind, date and a bounded snippet, without ranking attributes", () => {
		const long = "송신 자체가 아니라 훅이 12초 잠금 대기에서 죽는 것이고, 원인은 옛 버전 프로세스 하나가 잠금을 쥐고 있어서이다. ".repeat(20);
		const card = compactCandidateLine(knowledge(1216, long))!;
		expect(card.ref).toBe("kn:1216");
		expect(card.line).toMatch(/^kn:1216 knowledge 2026-10-05 · 송신 자체가 아니라/);
		expect(card.line).not.toContain("score=");
		expect(card.line).not.toContain("tags=");
		expect(card.line).not.toContain("\n");
		expect(card.line.length).toBeLessThanOrEqual(RECALL_SNIPPET_CHARS + 60);
		expect(card.line.endsWith("…")).toBe(true);
	});
	it("keeps a topic's full title and a bounded summary, dropping tags and embedded messages", () => {
		const card = compactCandidateLine(topic(11541, "Loom 메모리 저장 상태 확인 및 회상 타임아웃 진단", "사용자가 현재 작업이 Loom 메모리에 저장되고 있는지 물었고 ".repeat(15)))!;
		expect(card.ref).toBe("tp:11541");
		expect(card.line).toContain("topic 2026-10-01 · Loom 메모리 저장 상태 확인 및 회상 타임아웃 진단 — 사용자가 현재 작업이");
		expect(card.line).not.toContain("orgai-inc");
		expect(card.line).not.toContain("embedded message");
		expect(card.line.length).toBeLessThanOrEqual(RECALL_SNIPPET_CHARS + 120);
	});
	it("unwraps a Claude Code assistant record to the spoken text instead of its metadata", () => {
		const card = compactCandidateLine(claudeAssistant(118884, "네, 파악했습니다. 송신 자체가 아니라 **훅이 12초 잠금 대기에서 죽는 것**입니다."))!;
		expect(card.line).toBe("ep:118884 episode assistant 2026-10-05 · 네, 파악했습니다. 송신 자체가 아니라 **훅이 12초 잠금 대기에서 죽는 것**입니다.");
		expect(card.line).not.toContain("parentUuid");
	});
	it("unwraps a Claude Code user record whose content is a plain string", () => {
		expect(compactCandidateLine(claudeUser(121430, " 잠시만 현재 loom-memory 동작중?"))!.line).toBe("ep:121430 episode user 2026-10-06 · 잠시만 현재 loom-memory 동작중?");
	});
	it("unwraps a Codex response_item to its output_text", () => {
		expect(compactCandidateLine(codexAssistant(94840, "[loom-plugins] main에 올렸어."))!.line).toBe("ep:94840 episode assistant 2026-09-16 · [loom-plugins] main에 올렸어.");
	});
	it("drops machine records that carry no spoken text", () => {
		expect(compactCandidateLine(hookObservation(119244))).toBeNull();
		expect(compactCandidateLine(toolResult(5))).toBeNull();
	});
	it("keeps pre-plugin plain-text episodes as they are, unescaped", () => {
		expect(compactCandidateLine(legacyEpisode(92255, "withloom 저장소 직접 뒤져봤어요. <apps/web> & 끝"))!.line)
			.toBe("ep:92255 episode assistant 2026-07-28 · withloom 저장소 직접 뒤져봤어요. <apps/web> & 끝");
	});
	it("ignores lines that are not knowledge, topic or episode", () => {
		expect(compactCandidateLine('<relation-fact id="3" subject="a" predicate="b"/>')).toBeNull();
		expect(compactCandidateLine("not a line at all")).toBeNull();
	});
});

describe("recall block budget", () => {
	it("fits every one of 17 long server lines into the block as a card, in server order", () => {
		const lines: string[] = []; const candidates: Array<{ ref: string; label: string }> = [];
		for (let i = 0; i < 17; i++) {
			const id = 1000 + i;
			const text = `정답 ${i} `.repeat(i === 3 ? 2500 : 300);   // ~2–17KB per line, as observed in production
			lines.push(i % 3 === 0 ? claudeAssistant(id, text) : i % 3 === 1 ? topic(id, `제목 ${i}`, text) : knowledge(id, text));
			candidates.push({ ref: `${i % 3 === 0 ? "ep" : i % 3 === 1 ? "tp" : "kn"}:${id}`, label: "" });
		}
		expect(lines.reduce((n, l) => n + l.length, 0)).toBeGreaterThan(40_000);
		const block = buildRecallBlock({ candidate_lines: lines, candidates });
		expect(block.offered).toEqual(candidates.map(c => c.ref));
		expect(block.lines.join("\n").length).toBeLessThanOrEqual(RECALL_BLOCK_CHARS);
		expect(block.lines[3]).toContain("정답 3");
		expect(block.lines[16]).toContain("정답 16");
	});
	it("skips lines the server did not list as candidates and machine records, and stops at the block budget", () => {
		const block = buildRecallBlock({
			candidate_lines: [knowledge(1, "a".repeat(500)), hookObservation(2), knowledge(3, "b".repeat(500)), knowledge(4, "c".repeat(500))],
			candidates: [{ ref: "kn:1", label: "" }, { ref: "ep:2", label: "" }, { ref: "kn:4", label: "" }],
		}, { blockChars: 500 });
		expect(block.offered).toEqual(["kn:1"]);
		expect(block.lines).toHaveLength(1);
	});
});
