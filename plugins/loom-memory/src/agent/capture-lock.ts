import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Shared by hooks, cursor polling and graph transitions. Network uploads do not
 * hold it. A dead process cannot strand the lock; a live holder is never evicted. */
export async function captureLock<T>(home: string, fn: () => T | Promise<T>): Promise<T> {
	const path = join(home, "capture.lock"); const deadline = Date.now() + 12_000;
	await mkdir(home, { recursive: true, mode: 0o700 });
	for (;;) {
		try { await mkdir(path, { mode: 0o700 }); await writeFile(join(path, "pid"), String(process.pid)); break; }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			let dead = false;
			try { const pid = Number(await readFile(join(path, "pid"), "utf8")); if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0); } catch (e) { dead = (e as NodeJS.ErrnoException).code === "ESRCH"; } } }
			catch { dead = await stat(path).then(s => Date.now() - s.mtimeMs > 30_000).catch(() => false); }
			if (dead) { await rm(path, { recursive: true, force: true }); continue; }
			if (Date.now() >= deadline) throw new Error("Loom capture is busy. Retry shortly; the queue and graph are retained.");
			await new Promise(done => setTimeout(done, 25));
		}
	}
	try { return await fn(); } finally { await rm(path, { recursive: true, force: true }); }
}
