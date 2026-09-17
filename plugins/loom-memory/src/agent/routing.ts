import { accountKey, credentialKey, readConfig, type Config } from "./config.js";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { collect } from "./collector.js";
import { captureLock } from "./capture-lock.js";
import { Store, type Source } from "./store.js";
import { resolveProject, writeProjectGraph, type Project } from "./project.js";

export interface Scope { receipt?: string | undefined; cwd?: string | undefined; session?: string | undefined }
interface Binding extends Project { session: string }
interface Switch { id: string; session: string; from: string | null; graph: string | null; file: string; cwd: string; sources: Source[]; phase: "prepared" | "applied" }

/** The enrollment store owns the routing ledger. Each graph still has its own
 * durable cursor/outbox/receipt database. Bind once, then survive cwd/config edits,
 * process restarts and concurrent sessions without replaying a transcript elsewhere. */
export class Routing {
	private stores = new Map<string, Store>();
	private identity?: string;
	constructor(readonly home: string) {}
	private open(config: Config): Store {
		const key = accountKey(config);
		let store = this.stores.get(key);
		if (!store) { store = new Store(this.home, { ...config }); this.stores.set(key, store); }
		else Object.assign(store.config, config);
		return store;
	}
	async base(): Promise<Store> {
		const config = await readConfig(this.home);
		const identity = credentialKey(config);
		if (this.identity && this.identity !== identity) this.close();
		this.identity = identity;
		return this.open(config);
	}
	async all(): Promise<Store[]> {
		const base = await this.base();
		const rows = base.db.prepare("SELECT graph FROM project_sessions UNION SELECT NULLIF(graph,'') graph FROM project_graphs").all();
		return [...new Set([base, ...rows.map(row => this.open({ ...base.config, graph: (row.graph as string | null) ?? undefined }))])];
	}
	async select(scope: Scope = {}): Promise<{ store: Store; project?: Project | undefined }> {
		const base = await this.base();
		if (scope.receipt) {
			for (const store of await this.all()) {
				const receipt = store.db.prepare("SELECT session FROM receipts WHERE id=?").get(scope.receipt);
				if (receipt) {
					const project = base.db.prepare("SELECT * FROM project_sessions WHERE session=?").get(receipt.session as string) as unknown as Binding | undefined;
					return { store, project: project ? { ...project, graph: store.config.graph ?? null } : undefined };
				}
			}
			throw new Error("This Loom receipt was not found in the current account.");
		}
		if (scope.session) {
			const project = base.transaction(() => {
				const existing = base.db.prepare("SELECT * FROM project_sessions WHERE session=?").get(scope.session!) as unknown as Binding | undefined;
				if (existing) return existing;
				// Sessions collected before project routing keep their original graph.
				const legacy = base.db.prepare("SELECT 1 FROM sources WHERE session=? UNION SELECT 1 FROM receipts WHERE session=? LIMIT 1").get(scope.session!, scope.session!);
				const selected = scope.cwd ? resolveProject(scope.cwd) : undefined;
				const binding: Binding = { session: scope.session!, cwd: scope.cwd ?? "", file: selected?.file ?? null,
					graph: legacy || !selected?.file ? base.config.graph ?? null : selected.graph };
				base.db.prepare("INSERT INTO project_sessions(session,cwd,file,graph) VALUES (?,?,?,?)")
					.run(binding.session, binding.cwd, binding.file, binding.graph);
				return binding;
			});
			return { store: this.open({ ...base.config, graph: project.graph ?? undefined }), project };
		}
		if (scope.cwd) {
			const project = resolveProject(scope.cwd);
			// A cwd alone must not silently select a new graph for an existing session.
			const bindings = base.db.prepare("SELECT * FROM project_sessions WHERE cwd=?").all(project.cwd) as unknown as Binding[];
			const graphs = new Set(bindings.map(binding => binding.graph));
			if (graphs.size > 1) throw new Error("Multiple Loom session graphs exist here. Pass the current turn's receipt to select its graph.");
			if (bindings[0]) project.graph = bindings[0].graph;
			return { store: this.open({ ...base.config, graph: bindings[0] || project.file ? project.graph ?? undefined : base.config.graph }), project };
		}
		if ((await this.all()).some(store => store !== base)) {
			throw new Error("Pass the current Loom receipt or an absolute project cwd so the tool uses the correct .loom.yml graph.");
		}
		return { store: base };
	}
	/** Caller holds capture.lock. The journal makes partial cross-database progress
	 * restartable: target cursors are installed once, before their sources activate. */
	async recover(): Promise<void> {
		const base = await this.base();
		for (const row of base.db.prepare("SELECT value FROM graph_switches").all()) {
			const change = JSON.parse(row.value as string) as Switch;
			const old = this.open({ ...base.config, graph: change.from ?? undefined });
			const next = this.open({ ...base.config, graph: change.graph ?? undefined });
			if (change.phase === "prepared") {
				// Clearing the old path also fences pre-upgrade uploaders which do not
				// know the sealed column; the journal retains the original path.
				old.transaction(() => {
					for (const source of change.sources) {
						old.db.prepare("UPDATE sources SET sealed=1,ended=1,error=NULL,path='' WHERE id=?").run(source.id);
						old.db.prepare("UPDATE segments SET closed=1 WHERE source=?").run(source.id);
					}
				});
				next.transaction(() => {
					if (next.get(`switch:${change.id}`, false)) return;
					for (const source of change.sources) {
						const segment = `agent:${randomUUID()}`;
						next.db.prepare("INSERT INTO segments(id,source) VALUES (?,?)").run(segment, source.id);
						next.db.prepare(`INSERT INTO sources(id,session,path,offset,identity,tail_hash,segment,last_seen,ended,error,sealed)
						 VALUES (?,?,?,?,?,?,?,?,0,NULL,1) ON CONFLICT(id) DO UPDATE SET offset=excluded.offset,
						 path=excluded.path,identity=excluded.identity,tail_hash=excluded.tail_hash,segment=excluded.segment,last_seen=excluded.last_seen,ended=0,checkpoint=0,error=NULL,sealed=1`)
						 .run(source.id, source.session, source.path, source.offset, source.identity, source.tail_hash, segment, Date.now());
					}
					next.set(`switch:${change.id}`, true);
				});
				writeProjectGraph(change.file, change.graph);
				base.transaction(() => {
					base.db.prepare("INSERT OR REPLACE INTO project_sessions(session,cwd,file,graph) VALUES (?,?,?,?)").run(change.session, change.cwd, change.file, change.graph);
					change.phase = "applied";
					base.db.prepare("UPDATE graph_switches SET value=? WHERE session=?").run(JSON.stringify(change), change.session);
				});
			}
			next.transaction(() => { for (const source of change.sources) next.db.prepare("UPDATE sources SET sealed=0 WHERE id=?").run(source.id); });
			base.db.prepare("DELETE FROM graph_switches WHERE session=?").run(change.session);
		}
	}
	async switchGraph(scope: Scope, graph: string | null): Promise<unknown> {
		return captureLock(this.home, async () => {
			await this.recover();
			const base = await this.base();
			const selected = await this.select(scope);
			let session = scope.session;
			if (scope.receipt) session = selected.store.db.prepare("SELECT session FROM receipts WHERE id=? AND state='open'").get(scope.receipt)?.session as string | undefined;
			if (!session) throw new Error("Switching a running session requires its current receipt or session_id. Use cwd with session_id when recall was unavailable.");
			let binding = base.db.prepare("SELECT * FROM project_sessions WHERE session=?").get(session) as unknown as Binding | undefined;
			if (!binding) binding = (await this.select({ session, cwd: scope.cwd })).project as Binding;
			if (!binding.cwd && scope.cwd) Object.assign(binding, resolveProject(scope.cwd));
			if (!binding.cwd) throw new Error("Pass the absolute project cwd to establish .loom.yml before switching.");
			const current = this.open({ ...base.config, graph: binding.graph ?? undefined });
			const file = binding.file ?? join(binding.cwd, ".loom.yml");
			if ((binding.graph ?? null) === graph) { writeProjectGraph(file, graph); base.db.prepare("UPDATE project_sessions SET file=? WHERE session=?").run(file, session); return { switched: false, graph: graph ?? "personal", file }; }
			const sources = current.sources().filter(source => !source.sealed && (source.session === session || source.session.startsWith(`${session}:agent:`)));
			for (const source of sources) {
				// A bounded catch-up ensures we never skip old experience to switch quickly.
				for (let i = 0; i < 100; i++) {
					collect(current, source.id);
					const refreshed = current.db.prepare("SELECT * FROM sources WHERE id=?").get(source.id) as unknown as Source;
					Object.assign(source, refreshed);
					if (!source.path || !existsSync(source.path) || source.offset === statSync(source.path).size) break;
					if (source.error !== "Catching up with transcript.") throw new Error("Complete or repair the current transcript before switching; its cursor is retained.");
					if (i === 99) throw new Error("Transcript is still catching up. Retry the graph switch shortly.");
				}
			}
			const change: Switch = { id: randomUUID(), session, from: binding.graph, graph, file, cwd: binding.cwd, sources, phase: "prepared" };
			base.transaction(() => {
				for (const destination of [change.from, graph]) base.db.prepare("INSERT OR IGNORE INTO project_graphs VALUES (?)").run(destination ?? "");
				base.db.prepare("INSERT INTO graph_switches VALUES (?,?)").run(session, JSON.stringify(change));
			});
			await this.recover();
			return { switched: true, graph: graph ?? "personal", file, effective: "subsequent_capture", feedback: "existing_receipts_keep_original_graph" };
		});
	}
	close(): void { for (const store of this.stores.values()) store.close(); this.stores.clear(); }
}
