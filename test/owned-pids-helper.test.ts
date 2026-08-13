import { spawn } from "node:child_process";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { withDeadPid, withDeadPids, withLivePid, withLivePids } from "./helpers/owned-pids.js";

// The lifecycle fixtures depend on these helpers being facts rather than
// approximations, so the helpers themselves need coverage. The hang is the
// dangerous one: a helper that never resolves turns a test failure into a
// suite that sits there until the runner's timeout, with no useful output.

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error ? error.code : null;
		return code === "EPERM";
	}
}

describe("owned-pids", () => {
	it("hands out a PID that is genuinely dead", async () => {
		await withDeadPid((pid) => {
			expect(Number.isInteger(pid)).toBe(true);
			expect(pid).toBeGreaterThan(0);
			expect(isAlive(pid)).toBe(false);
		});
	});

	it("hands out a PID that is genuinely alive, and reaps it afterwards", async () => {
		let captured = 0;
		await withLivePid((pid) => {
			captured = pid;
			expect(isAlive(pid)).toBe(true);
		});
		// Killed on the way out rather than left for the OS.
		expect(isAlive(captured)).toBe(false);
	});

	it("kills the live PID even when the body throws", async () => {
		let captured = 0;
		await expect(
			withLivePid((pid) => {
				captured = pid;
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(isAlive(captured)).toBe(false);
	});

	it("produces distinct PIDs in batches larger than one spawn round", async () => {
		// The batch size is an implementation detail; asking for more than one
		// batch is what proves the loop stitches them together rather than
		// returning only the last batch.
		const count = 40;
		await withDeadPids(count, (pids) => {
			expect(pids).toHaveLength(count);
			expect(new Set(pids).size).toBe(count);
			for (const pid of pids) {
				expect(isAlive(pid)).toBe(false);
			}
		});
	}, 60_000);

	it("keeps every PID in a live batch alive for the body and reaps them after", async () => {
		let captured: number[] = [];
		await withLivePids(5, (pids) => {
			captured = [...pids];
			expect(new Set(pids).size).toBe(pids.length);
			for (const pid of pids) {
				expect(isAlive(pid)).toBe(true);
			}
		});
		for (const pid of captured) {
			expect(isAlive(pid)).toBe(false);
		}
	}, 60_000);

	it("settles rather than hanging when a child never spawns", async () => {
		// A child that fails to spawn emits `error` and never `exit`. The batched
		// helpers await a whole batch concurrently, so waiting on `exit` alone
		// meant one failed spawn stalled every sibling and hung the run instead of
		// failing it. This asserts the settle, with a timeout well under vitest's
		// so a regression reads as a failure here rather than as a stuck suite.
		const child = spawn(
			"definitely-not-a-real-binary-2f8c1d",
			["--nope"],
			{ stdio: ["pipe", "ignore", "ignore"] },
		);
		const settled = await Promise.race([
			new Promise<string>((resolve) => {
				let done = false;
				const finish = (label: string) => () => {
					if (done) return;
					done = true;
					resolve(label);
				};
				child.once("exit", finish("exit"));
				child.once("error", finish("error"));
			}),
			new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 5_000)),
		]);
		// The premise of the fix: this child signals via `error`, not `exit`.
		expect(settled).toBe("error");
		child.stdin?.destroy();
	}, 30_000);
});
