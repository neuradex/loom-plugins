import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";

export interface Project { cwd: string; file: string | null; graph: string | null }
export function readProjectFile(file: string): Record<string, unknown> {
	try {
		if (statSync(file).size > 65_536) throw new Error();
		const value = parse(readFileSync(file, "utf8"), { maxAliasCount: 20 }) ?? {};
		if (typeof value !== "object" || Array.isArray(value)) throw new Error();
		return value;
	} catch { throw new Error("Loom .loom.yml cannot be read. Repair it before capture resumes; the destination was not changed."); }
}
/** Same filename, nearest-parent lookup and empty-graph meaning as loom-cli's
 * src/loom-config.ts. Credentials and API URLs never come from this file. */
export function resolveProject(cwd: string): Project {
	if (!isAbsolute(cwd)) throw new Error("Loom needs an absolute project cwd.");
	const start = resolve(cwd);
	for (let dir = start; ; dir = dirname(dir)) {
		const file = join(dir, ".loom.yml");
		if (existsSync(file)) {
			const doc = readProjectFile(file);
			if (doc.graph != null && typeof doc.graph !== "string") throw new Error("Loom .loom.yml graph must be a string. Capture is paused until it is repaired.");
			return { cwd: start, file, graph: typeof doc.graph === "string" ? doc.graph.trim() || null : null };
		}
		if (dirname(dir) === dir) return { cwd: start, file: null, graph: null };
	}
}
