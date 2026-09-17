import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { readProjectFile } from "./project.js";

const schema = z.object({
	notifications: z.object({ recall_errors: z.boolean().default(false) }).strict().default({ recall_errors: false }),
}).strict();

/** Project preferences share .loom.yml with Loom CLI. The old 0.2.2
 * installation file is only a compatibility fallback when no project file exists.
 * A broken preference file must not stop capture or create recurring warnings. */
export function readSettings(home: string, projectFile?: string | null) {
	const defaults = { notifications: { recall_errors: false } };
	if (projectFile) {
		try {
			const doc = readProjectFile(projectFile);
			// Only this namespace is ours; CLI and future settings remain untouched.
			const result = schema.safeParse({ notifications: doc.notifications });
			return result.success ? result.data : { ...defaults, settingsError: "invalid_settings" };
		} catch { return { ...defaults, settingsError: "invalid_yaml" }; }
	}
	let source: string;
	try {
		const path = join(home, "settings.yaml");
		if (statSync(path).size > 65_536) return { ...defaults, settingsError: "too_large" };
		source = readFileSync(path, "utf8");
	} catch (error) {
		return { ...defaults, ...((error as NodeJS.ErrnoException).code === "ENOENT" ? {} : { settingsError: "unreadable" }) };
	}
	let value: unknown;
	try { value = parse(source, { maxAliasCount: 20 }); }
	catch { return { ...defaults, settingsError: "invalid_yaml" }; }
	const result = schema.safeParse(value ?? {});
	return result.success ? { ...result.data, settingsError: undefined } : { ...defaults, settingsError: "invalid_settings" };
}
