import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";

/**
 * PIDs the test owns, instead of sentinels the test hopes are unused.
 *
 * Helper-lifecycle fixtures used to stand in for "dead" with integers above the
 * platform PID ceiling (`99999999`, `2_147_483_646`) and for "a second live
 * process" with `process.ppid`. Neither is a fact the test controls:
 * `process.kill` may raise `EINVAL` rather than `ESRCH` for an out-of-range
 * PID — which happens to classify as dead only because every liveness check in
 * this tree treats every errno but `EPERM` as dead — and `process.ppid` inside
 * a vitest worker is the pool process, whose identity and lifetime differ
 * between the `threads` and `forks` pools and which can exit mid-run (#668).
 *
 * Spawning a process and killing it makes "dead" a fact; keeping one alive for
 * the duration of a test makes "live" a fact.
 */

function spawnIdleChild(): ChildProcess {
	// Reads stdin forever and does nothing else. stdin is a pipe the parent
	// holds open, so the child stays alive until it is signalled, without a
	// timer that could fire first.
	return spawn(process.execPath, ["-e", "process.stdin.resume()"], {
		stdio: ["pipe", "ignore", "ignore"],
	});
}

async function waitForExit(child: ChildProcess): Promise<void> {
	if (child.exitCode === null && child.signalCode === null) {
		await new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
		});
	}
	// `exit` fires before the stdio streams are torn down, so the parent's write
	// end of the stdin pipe is still open here and would linger until GC. Every
	// call site opens at least one, several open three at once, and on Windows
	// these are named-pipe handles — the scarcer resource. Close it explicitly
	// so the lifetime is the helper's, not the collector's.
	child.stdin?.destroy();
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error ? error.code : null;
		return code === "EPERM";
	}
}

/**
 * A PID that is genuinely dead: a child this process started, signalled, and
 * reaped.
 *
 * Deadness is re-asserted immediately before the PID is handed over, because
 * "a just-exited PID is not reused" is only true where PIDs come from a
 * monotonic counter. Linux and macOS qualify; Windows does not — its PIDs come
 * from a pool and can be handed out again promptly. The callers that assert
 * unbind *removes* a dead PID's files run on every platform, so a recycled PID
 * would make unbind correctly preserve the file and the test fail — an
 * intermittent Windows-only failure in a cleanup test, which looks exactly
 * like the bug the test guards. The check turns that into an immediate,
 * legible fixture error instead.
 */
export async function withDeadPid<T>(
	run: (pid: number) => Promise<T> | T,
): Promise<T> {
	const child = spawnIdleChild();
	const pid = child.pid;
	if (pid === undefined) throw new Error("failed to spawn a probe process");
	child.kill("SIGKILL");
	await waitForExit(child);
	if (isPidAlive(pid)) {
		throw new Error(
			`owned-pids: pid ${pid} was recycled between reaping it and using it; ` +
				"this fixture needs a PID that stays dead for the length of the test",
		);
	}
	return await run(pid);
}

/**
 * `count` distinct dead PIDs at once, so a fixture needing several does not
 * nest `withDeadPid` callbacks one inside the next.
 */
export async function withDeadPids<T>(
	count: number,
	run: (pids: number[]) => Promise<T> | T,
): Promise<T> {
	// Spawned and reaped in batches rather than all at once. The stress fixtures
	// ask for hundreds, and launching that many processes simultaneously can hit
	// a process-table or fd limit and fail the spawn — which would surface as a
	// fixture error indistinguishable from the bug under test. Batching keeps the
	// instantaneous footprint small while still yielding `count` distinct PIDs.
	const batchSize = 32;
	const deadPids: number[] = [];
	for (let offset = 0; offset < count; offset += batchSize) {
		const size = Math.min(batchSize, count - offset);
		const children = Array.from({ length: size }, () => spawnIdleChild());
		const pids = children.map((child) => child.pid);
		await Promise.all(
			children.map(async (child) => {
				child.kill("SIGKILL");
				await waitForExit(child);
			}),
		);
		if (pids.some((pid) => pid === undefined)) {
			throw new Error("failed to spawn a probe process");
		}
		deadPids.push(...(pids as number[]));
	}
	const recycled = deadPids.filter((pid) => isPidAlive(pid));
	if (recycled.length > 0) {
		throw new Error(
			`owned-pids: pid(s) ${recycled.join(", ")} were recycled between ` +
				"reaping them and using them; this fixture needs PIDs that stay dead",
		);
	}
	return await run(deadPids);
}

/**
 * A PID that is genuinely alive for the duration of `run`, and killed
 * afterwards whether `run` throws or not.
 */
export async function withLivePid<T>(
	run: (pid: number) => Promise<T> | T,
): Promise<T> {
	const child = spawnIdleChild();
	const pid = child.pid;
	if (pid === undefined) throw new Error("failed to spawn a probe process");
	try {
		return await run(pid);
	} finally {
		child.kill("SIGKILL");
		await waitForExit(child);
	}
}

/**
 * `count` distinct live PIDs at once, all killed afterwards whether `run`
 * throws or not. Used where a fixture needs more concurrent live helpers than
 * the code under test's parallelism bound.
 */
export async function withLivePids<T>(
	count: number,
	run: (pids: number[]) => Promise<T> | T,
): Promise<T> {
	const children = Array.from({ length: count }, () => spawnIdleChild());
	try {
		const pids = children.map((child) => child.pid);
		if (pids.some((pid) => pid === undefined)) {
			throw new Error("failed to spawn a probe process");
		}
		return await run(pids as number[]);
	} finally {
		await Promise.all(
			children.map(async (child) => {
				child.kill("SIGKILL");
				await waitForExit(child);
			}),
		);
	}
}
