import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";

export const configSchema = z.object({
	token: z.string().min(1),
	url: z.string().url().default("https://api.neuradex.ai"),
	graph: z.string().min(1).optional(),
	// One enrollment enables full capture. This is not a per-event importance filter.
	capture: z.boolean().default(true),
	recall: z.boolean().default(true),
	batchEvents: z.number().int().min(1).max(500).default(100),
	batchBytes: z.number().int().min(16_384).max(2_097_152).default(524_288),
	flushMs: z.number().int().min(1_000).max(60_000).default(10_000),
	maxQueueBytes: z.number().int().min(1_048_576).default(1_073_741_824),
	segmentIdleMs: z.number().int().min(10_000).default(60_000),
	segmentMaxMs: z.number().int().min(60_000).default(300_000),
}).strict();
export type Config = z.infer<typeof configSchema>;

export const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
export function dataHome(): string {
	return resolve(process.env.LOOM_MEMORY_HOME ?? join(homedir(), ".loom", "agent-memory"));
}

export function validateConfig(value: unknown): Config {
	const config = configSchema.parse(value);
	const url = new URL(config.url);
	if (url.username || url.password || url.search || url.hash ||
		(url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
		throw new Error("Memory URL must use HTTPS (HTTP is allowed only on loopback), without credentials, query or fragment.");
	}
	config.url = config.url.replace(/\/+$/, "");
	return config;
}

export async function readConfig(home = dataHome()): Promise<Config> {
	let value: unknown;
	try { value = JSON.parse(await readFile(join(home, "config.json"), "utf8")); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error("Loom Memory is not configured. Run the plugin CLI configure command before enabling capture.");
		}
		throw new Error("Loom Memory config.json cannot be read or parsed. Repair it with the configure command.");
	}
	return validateConfig(value);
}

export async function saveConfig(value: unknown, home = dataHome()): Promise<void> {
	const config = validateConfig(value);
	await mkdir(home, { recursive: true, mode: 0o700 });
	await writeFile(join(home, "config.json"), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
	await chmod(join(home, "config.json"), 0o600);
}

// Never replay one identity's queued experience using another identity's credential.
// Token rotation leaves the old queue intact; drain it before changing credentials.
export function accountKey(config: Config): string {
	return digest(JSON.stringify([config.url, config.graph ?? "", config.token]));
}
