import { accountKey, credentialKey, readConfig, type Config } from "./config.js";
import { Store } from "./store.js";
import { resolveProject, type Project } from "./project.js";

export interface Scope { receipt?: string | undefined; cwd?: string | undefined; session?: string | undefined }
interface Binding extends Project { session: string }

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
		const rows = base.db.prepare("SELECT DISTINCT graph FROM project_sessions").all();
		return [...new Set([base, ...rows.map(row => this.open({ ...base.config, graph: (row.graph as string | null) ?? undefined }))])];
	}
	async select(scope: Scope = {}): Promise<{ store: Store; project?: Project | undefined }> {
		const base = await this.base();
		if (scope.receipt) {
			for (const store of await this.all()) {
				const receipt = store.db.prepare("SELECT session FROM receipts WHERE id=?").get(scope.receipt);
				if (receipt) {
					const project = base.db.prepare("SELECT * FROM project_sessions WHERE session=?").get(receipt.session as string) as unknown as Binding | undefined;
					return { store, project };
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
	close(): void { for (const store of this.stores.values()) store.close(); this.stores.clear(); }
}
