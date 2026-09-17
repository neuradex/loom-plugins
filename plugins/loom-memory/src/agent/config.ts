import { mkdir, readFile, writeFile, chmod, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const configSchema = z.object({
	token: z.string().min(1),
	userId: z.string().uuid().optional(),
	oauth: z.object({ refreshToken: z.string().min(1), expiresAt: z.number().positive(), needsReconnect: z.boolean().optional() }).strict().optional(),
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
export class NotConnectedError extends Error {
	constructor() { super("Connect Loom in the host's MCP authentication UI to enable automatic memory."); }
}

export const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
export function dataHome(): string {
	return resolve(process.env.LOOM_MEMORY_HOME ?? join(homedir(), ".loom", "agent-memory"));
}

export function validateConfig(value: unknown): Config {
	const config = configSchema.parse(value);
	if (config.oauth && !config.userId) throw new Error("OAuth configuration requires an account identity.");
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
			throw new NotConnectedError();
		}
		throw new Error("Loom Memory config.json cannot be read or parsed. Repair it with the configure command.");
	}
	return validateConfig(value);
}

export async function saveConfig(value: unknown, home = dataHome()): Promise<void> {
	const config = validateConfig(value);
	await mkdir(home, { recursive: true, mode: 0o700 });
	await atomicJson(join(home, "config.json"), config);
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
		await chmod(temporary, 0o600);
		await rename(temporary, path);
	} finally { await rm(temporary, { force: true }); }
}

// OAuth refresh changes credentials, never the account/graph owning the outbox.
// Legacy manually configured tokens retain their original queue key.
export function accountKey(config: Config): string {
	return digest(JSON.stringify([config.url, config.graph ?? "", config.userId ? `user:${config.userId}` : config.token]));
}
