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
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolve) => {
		child.once("exit", () => resolve());
	});
}

/**
 * A PID that is genuinely dead: a child this process started, signalled, and
 * reaped. The PID is not reused while the test runs on any platform this suite
 * targets, because the kernel does not immediately recycle a just-exited PID.
 */
export async function withDeadPid<T>(
	run: (pid: number) => Promise<T> | T,
): Promise<T> {
	const child = spawnIdleChild();
	const pid = child.pid;
	if (pid === undefined) throw new Error("failed to spawn a probe process");
	child.kill("SIGKILL");
	await waitForExit(child);
	return await run(pid);
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
