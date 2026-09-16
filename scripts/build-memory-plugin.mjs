import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
export async function buildMemoryPlugin(destination = join(root, 'plugins/loom-memory')) {
  await mkdir(join(destination, 'dist'), { recursive: true });
  const result = await build({
    absWorkingDir: root, entryPoints: ['plugins/loom-memory/src/agent/cli.ts'],
    outfile: join(destination, 'dist/cli.js'), bundle: true, platform: 'node',
    format: 'esm', target: 'node22', metafile: true,
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    logLevel: 'warning',
  });
  const packages = new Map();
  for (const input of Object.keys(result.metafile.inputs)) {
    if (!input.includes('node_modules/')) continue;
    let dir = dirname(join(root, input));
    while (dir !== root && dir !== dirname(dir)) {
      try {
        const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
        if (pkg.name && pkg.version) { packages.set(pkg.name, { dir, pkg }); break; }
      } catch {}
      dir = dirname(dir);
    }
  }
  const notices = [];
  for (const [name, { dir, pkg }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    let license;
    for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md']) {
      try { license = await readFile(join(dir, file), 'utf8'); break; } catch {}
    }
    if (!license) throw new Error(`Bundled dependency license missing: ${name}`);
    notices.push(`${name}@${pkg.version} (${pkg.license})\n${license.trim()}`);
  }
  await writeFile(join(destination, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n\n========================================\n\n') + '\n');
  return destination;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(await buildMemoryPlugin(process.argv[2]));
