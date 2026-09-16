import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, 'plugins/loom-memory/dist/cli.js');
const quoteShell = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const hook = `node ${quoteShell(cli)} hook`;
console.log(`# Merge with your existing config; preserve other hooks.\n[features]\nhooks = true\n\n[mcp_servers.loom_memory]\ncommand = "node"\nargs = [${JSON.stringify(cli)}, "mcp"]\n\n[mcp_servers.loom_memory.tools.report_memory_use]\napproval_mode = "approve"`);
for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) {
  console.log(`\n[[hooks.${event}]]\nhooks = [{ type = "command", command = ${JSON.stringify(hook)}, timeout = ${event === 'SessionEnd' ? 3 : 12} }]`);
}
