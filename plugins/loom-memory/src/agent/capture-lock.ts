import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** Default wait for collectors that may block (the worker's pump, graph switches). */
export const DEFAULT_WAIT_MS = 12_000;
/** Longest a healthy owner can hold the lock. Owners do local file and SQLite
 * work only, and a 0.3.1+ worker ends itself after 60 seconds. An older lock
 * belongs to a wedged process or to a pre-watchdog version that will never let
 * go: one 0.3.0 process held the lock idle for 12 hours while every newer hook
 * waited its full budget and was killed by the host. */
export const STALE_HOLD_MS = 120_000;
/** Grace for a directory whose owner has not published its PID yet. */
const UNPUBLISHED_GRACE_MS = 30_000;

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Remove a lock whose owner is dead or has held it beyond STALE_HOLD_MS. The
 * rename takes it out of the way atomically, so two waiters cannot both evict
 * the same directory and then one of them remove the other's fresh lock. */
async function evictIfStale(path: string): Promise<boolean> {
	let info;
	try { info = await stat(path); } catch { return true; }
	const age = Date.now() - info.mtimeMs;
	const pid = Number(await readFile(join(path, "pid"), "utf8").catch(() => ""));
	const published = Number.isInteger(pid) && pid > 0;
	if (published ? alive(pid) && age <= STALE_HOLD_MS : age <= UNPUBLISHED_GRACE_MS) return false;
	// The entry judged stale must still be the one at this path.
	const again = await stat(path).catch(() => undefined);
	if (!again || again.ino !== info.ino) return true;
	const tomb = `${path}.${randomUUID()}.evicted`;
	try { await rename(path, tomb); } catch { return true; }
	await rm(tomb, { recursive: true, force: true });
	return true;
}

/** Shared by hooks, cursor polling and graph transitions. Network requests do
 * not hold it. A dead owner is evicted at once; a live owner only after
 * STALE_HOLD_MS. Hooks pass a `waitMs` below the host's hook timeout, so the
 * host receives a "busy" answer instead of killing the hook. */
export async function captureLock<T>(home: string, fn: () => T | Promise<T>, options: { waitMs?: number } = {}): Promise<T> {
	const path = join(home, "capture.lock");
	const owner = randomUUID();
	const deadline = Date.now() + (options.waitMs ?? DEFAULT_WAIT_MS);
	await mkdir(home, { recursive: true, mode: 0o700 });
	for (;;) {
		try { await mkdir(path, { mode: 0o700 }); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (await evictIfStale(path)) continue;
			if (Date.now() >= deadline) throw new Error("Loom capture is busy. Retry shortly; the queue and graph are retained.");
			await new Promise(done => setTimeout(done, 25));
			continue;
		}
		try {
			// The bare PID stays readable to every shipped version; the owner token
			// lets only this acquisition release the directory.
			await writeFile(join(path, "pid"), String(process.pid));
			await writeFile(join(path, "owner"), owner);
		} catch (error) { await rm(path, { recursive: true, force: true }); throw error; }
		break;
	}
	try { return await fn(); }
	finally {
		// An owner evicted as stale may wake after a replacement took the lock;
		// it must not remove the replacement's directory.
		const current = await readFile(join(path, "owner"), "utf8").catch(() => undefined);
		if (current === owner) await rm(path, { recursive: true, force: true });
	}
}
