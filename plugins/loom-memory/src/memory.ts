/**
 * memory API 클라이언트 — 이 서비스의 유일한 바깥이다.
 *
 * 툴은 계약을 **다시 구현하지 않는다.** 랭킹도, source='user' 강제도, 그래프 경계도
 * 전부 memory 쪽 라우트가 소유하고 여기는 HTTP 로 그걸 부른다 (docs/manual-memory-ops.md).
 * 계약이 두 벌이 되면 한쪽만 고쳐지는 날이 오고, 그때 MCP 유저와 loom-cli 유저가
 * 같은 그래프에서 다른 답을 받는다.
 *
 * 자격증명은 **들고 있지 않고 넘긴다.** 클라이언트의 Bearer 를 그대로 실어 보내므로
 * 유저 해석·API 키 조회·멤버십 판정이 전부 memory 의 gatewayAuth 한 곳에서 일어난다.
 */

/** /retrieve/query 결과 (memory retrieval/structured-results.ts QueryResult) */
export interface MemoryQueryHit {
	ref: string;
	type: "knowledge" | "topic" | "episode";
	id: number;
	title: string | null;
	snippet: string;
	score: number;
	source?: string | null;
	actor_type?: string;
}

/** /retrieve/read 결과 (memory retrieval/read.ts MemoryReadItem) */
export interface MemoryReadHit {
	ref: string;
	type: "knowledge" | "topic" | "episode";
	title: string | null;
	content: string;
	date: string;
	actor_type?: string;
	session_id?: string | null;
	truncated: boolean;
}

export interface RememberResult {
	ok: true;
	id: number;
	related: Array<{ id: number; title: string | null; distance: number }>;
}

export interface MemoryCounts {
	[key: string]: unknown;
}

export interface GraphSummary {
	id: string;
	name?: string | null;
	slug?: string | null;
	kind?: string | null;
}

/** 호출자의 자격 — 검증하지 않고 그대로 넘긴다 (판정은 memory 의 gatewayAuth) */
export interface MemoryAuth {
	/** Authorization 헤더의 Bearer 원문 */
	token: string;
	/** X-Loom-Graph — 조직 그래프 선택. 미지정이면 개인 그래프 */
	graph?: string | undefined;
}

/**
 * memory 가 돌려준 실패. **status 를 들고 다니는 게 요점이다** — 401 은 재인증,
 * 403 은 권한, 400 은 모델이 고칠 수 있는 입력 오류로 서로 다르게 번역된다.
 */
export class MemoryApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		readonly detail?: unknown,
	) {
		super(`memory ${status} ${code}`);
		this.name = "MemoryApiError";
	}

	/** 토큰이 죽었다 — 커넥터에게 다시 인가받으라고 말해야 하는 유일한 경우 */
	get isAuth(): boolean {
		return this.status === 401;
	}
}

export interface MemoryClient {
	query(auth: MemoryAuth, body: QueryBody): Promise<{ results: MemoryQueryHit[] }>;
	read(auth: MemoryAuth, body: ReadBody): Promise<{ results: MemoryReadHit[] }>;
	remember(auth: MemoryAuth, body: RememberBody): Promise<RememberResult>;
	counts(auth: MemoryAuth): Promise<MemoryCounts>;
	recent(auth: MemoryAuth, n: number): Promise<{ episodes: unknown[] }>;
	graphs(auth: MemoryAuth): Promise<{ graphs: GraphSummary[] }>;
}

export interface QueryBody {
	text: string;
	limit?: number | undefined;
	types?: ReadonlyArray<"knowledge" | "topic" | "episode"> | undefined;
}

export interface ReadBody {
	refs: string[];
	max_chars_per_item?: number | undefined;
}

export interface RememberBody {
	content: string;
	title?: string | undefined;
	category?: string | undefined;
	tags?: string[] | undefined;
	topic_id?: number | undefined;
}

export interface MemoryClientOptions {
	/** 테스트 주입 지점 — 미지정이면 전역 fetch */
	fetch?: typeof globalThis.fetch;
	/** 호출 상한 (ms). memory 가 안 돌아오면 툴이 영원히 매달리지 않는다 */
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function createMemoryClient(baseUrl: string, options: MemoryClientOptions = {}): MemoryClient {
	const doFetch = options.fetch ?? globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	async function call<T>(auth: MemoryAuth, path: string, init: RequestInit = {}): Promise<T> {
		const headers = new Headers(init.headers);
		headers.set("authorization", `Bearer ${auth.token}`);
		if (auth.graph) headers.set("x-loom-graph", auth.graph);
		if (init.body !== undefined) headers.set("content-type", "application/json");

		let res: Response;
		try {
			res = await doFetch(`${baseUrl}${path}`, {
				...init,
				headers,
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (err) {
			// 네트워크·타임아웃은 **거절이 아니다.** 둘을 같은 코드로 뭉개면 클라이언트가
			// "권한 없음"과 "서버에 못 닿음"을 구분하지 못한다 (0025 의 교훈과 같은 축).
			const message = err instanceof Error ? err.message : String(err);
			throw new MemoryApiError(503, "memory_unreachable", message);
		}

		const text = await res.text();
		const parsed: unknown = text ? safeJson(text) : null;

		if (!res.ok) {
			const code =
				parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string"
					? (parsed as { error: string }).error
					: `http_${res.status}`;
			throw new MemoryApiError(res.status, code, parsed);
		}
		return parsed as T;
	}

	return {
		query: (auth, body) => call(auth, "/retrieve/query", { method: "POST", body: JSON.stringify(body) }),
		read: (auth, body) => call(auth, "/retrieve/read", { method: "POST", body: JSON.stringify(body) }),
		remember: (auth, body) => call(auth, "/ingest/knowledge", { method: "POST", body: JSON.stringify(body) }),
		counts: (auth) => call(auth, "/me/memory/counts"),
		recent: (auth, n) => call(auth, `/me/memory/recent?n=${n}`),
		graphs: (auth) => call(auth, "/me/graphs"),
	};
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return { error: "non_json_response", body: text.slice(0, 200) };
	}
}
