import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

/** Which Orca surface hosts this coding session. The Memory API uses it to treat
 * long-lived bot sessions differently from dispatched workers and people's chats. */
export type ClientContext = "orca-worker" | "orca-bot" | "orca-chat" | "orca-terminal";

function inside(path: string, dir: string): boolean {
	const rel = relative(dir, path);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Derived in the hook process, which inherits the host's environment; the MCP
 * worker and the flush child run with a different one and must not guess. Only the
 * presence of the variables is read: no token value leaves this function. It is a
 * label for the server; nothing is dropped on the client. A dispatched worker is
 * checked first, because a worker started from a bot inherits the bot's variables. */
export function clientContext(env: NodeJS.ProcessEnv, cwd?: string, home = homedir()): ClientContext | undefined {
	if (env.ORCA_TERMINAL_HANDLE?.startsWith("structworker_")) return "orca-worker";
	if (env.ORCA_BOT_TOOLS_TOKEN || (cwd && inside(cwd, join(home, ".orca", "bots")))) return "orca-bot";
	if (env.ORCA_STRUCTURED_SESSION === "1") return "orca-chat";
	if (env.ORCA_TERMINAL_HANDLE) return "orca-terminal";
	return undefined;
}
