import { describe, expect, it, vi } from "vitest";
import type { HealthCheckOptions } from "../lib/codex-manager/health-check.js";
import {
	parseRemoveArgs,
	runRemoveCommand,
	type RemoveCommandDeps,
} from "../lib/codex-manager/commands/remove.js";
import {
	removeAccountFromStorage,
	type AccountRemovalDeps,
} from "../lib/codex-manager/account-removal.js";
import type {
	AccountMetadataV3,
	AccountStorageV3,
} from "../lib/storage.js";

const NOW = 1_800_000_000_000;

function account(id: string): AccountMetadataV3 {
	return {
		accountId: `acc_${id}`,
		email: `${id}@example.com`,
		refreshToken: `refresh-${id}`,
		accessToken: `access-${id}`,
		expiresAt: NOW + 3_600_000,
		addedAt: NOW - 60_000,
		lastUsed: NOW - 60_000,
	};
}

function storageWith(accounts: AccountMetadataV3[]): AccountStorageV3 {
	return {
		version: 3,
		accounts,
		activeIndex: 2,
		activeIndexByFamily: { codex: 2, "gpt-5.1": 0 },
		pinnedAccountIndex: 2,
		affinityGeneration: 4,
	};
}

function persistenceDeps(
	current: AccountStorageV3 | null,
	onPersist: (storage: AccountStorageV3) => void,
): AccountRemovalDeps {
	return {
		withAccountStorageTransaction: async (handler) =>
			handler(current, async (storage) => onPersist(structuredClone(storage))),
	};
}

function commandState(
	overrides: Partial<RemoveCommandDeps> = {},
): {
	deps: RemoveCommandDeps;
	info: string[];
	errors: string[];
} {
	const info: string[] = [];
	const errors: string[] = [];
	const storage: AccountStorageV3 = {
		version: 3,
		accounts: [account("a"), account("b")],
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
	};
	const deps: RemoveCommandDeps = {
		setStoragePath: vi.fn(),
		loadAccounts: vi.fn(async () => storage),
		runHealthCheck: vi.fn(async () => undefined),
		isInteractive: () => false,
		promptAccount: vi.fn(async () => null),
		confirmRemoval: vi.fn(async () => true),
		removeAccount: vi.fn(async (selected) => ({
			removed: true,
			removedIndex: storage.accounts.indexOf(selected),
			storage: {
				...storage,
				accounts: storage.accounts.filter((entry) => entry !== selected),
			},
		})),
		logInfo: (message) => info.push(message),
		logError: (message) => errors.push(message),
		...overrides,
	};
	return { deps, info, errors };
}

describe("remove argument parser", () => {
	it("supports an interactive picker and an indexed non-interactive form", () => {
		expect(parseRemoveArgs([])).toEqual({
			ok: true,
			options: { index: undefined, yes: false, runCheck: true },
		});
		expect(parseRemoveArgs(["2", "--yes", "--no-check"])).toEqual({
			ok: true,
			options: { index: 2, yes: true, runCheck: false },
		});
	});

	it("rejects malformed indexes, duplicate selectors, and unknown flags", () => {
		for (const args of [["0"], ["1.5"], ["1", "2"], ["--unknown"]]) {
			expect(parseRemoveArgs(args)).toMatchObject({
				ok: false,
				reason: "error",
			});
		}
	});
});

describe("account removal persistence", () => {
	it("removes by identity and repairs active, family, pin, and affinity state", async () => {
		const current = storageWith([account("a"), account("b"), account("c")]);
		const persisted: AccountStorageV3[] = [];

		const result = await removeAccountFromStorage(
			current.accounts[0]!,
			persistenceDeps(current, (storage) => persisted.push(storage)),
		);

		expect(result.removed).toBe(true);
		expect(persisted).toHaveLength(1);
		const saved = persisted[0]!;
		expect(saved.accounts.map((entry) => entry.accountId)).toEqual([
			"acc_b",
			"acc_c",
		]);
		expect(saved.activeIndex).toBe(1);
		expect(saved.activeIndexByFamily?.codex).toBe(1);
		expect(saved.activeIndexByFamily?.["gpt-5.1"]).toBe(0);
		expect(saved.pinnedAccountIndex).toBe(1);
		expect(saved.affinityGeneration).toBeGreaterThan(4);
	});

	it("re-resolves a selected account after a concurrent reorder", async () => {
		const selected = account("a");
		const current: AccountStorageV3 = {
			version: 3,
			accounts: [account("x"), selected],
			activeIndex: 0,
		};
		let persisted: AccountStorageV3 | null = null;

		const result = await removeAccountFromStorage(
			account("a"),
			persistenceDeps(current, (storage) => {
				persisted = storage;
			}),
		);

		expect(result).toMatchObject({ removed: true, removedIndex: 1 });
		expect(persisted?.accounts.map((entry) => entry.accountId)).toEqual([
			"acc_x",
		]);
	});

	it("does not persist when the selected identity has vanished", async () => {
		const persist = vi.fn();
		const result = await removeAccountFromStorage(
			account("a"),
			persistenceDeps(
				{
					version: 3,
					accounts: [account("b")],
					activeIndex: 0,
				},
				persist,
			),
		);

		expect(result).toEqual({ removed: false });
		expect(persist).not.toHaveBeenCalled();
	});
});

describe("remove command", () => {
	it("runs the live check, shows its statuses to the picker, and removes the selected account", async () => {
		const promptAccount = vi.fn(async () => 1);
		const runHealthCheck = vi.fn(async (options: HealthCheckOptions) => {
			options.onAccountResult?.({
				index: 0,
				accountId: "acc_a",
				email: "a@example.com",
				status: "codex-available",
				detail: "5h 90% left",
			});
			options.onAccountResult?.({
				index: 1,
				accountId: "acc_b",
				email: "b@example.com",
				status: "needs-relogin",
				detail: "invalid_grant",
			});
		});
		const removeAccount = vi.fn(async () => ({
			removed: true as const,
			removedIndex: 1,
			storage: {
				version: 3 as const,
				accounts: [account("a")],
				activeIndex: 0,
			},
		}));
		const state = commandState({
			isInteractive: () => true,
			promptAccount,
			runHealthCheck,
			removeAccount,
		});

		expect(await runRemoveCommand([], state.deps)).toBe(0);
		expect(runHealthCheck).toHaveBeenCalledWith(
			expect.objectContaining({ liveProbe: true }),
		);
		expect(promptAccount).toHaveBeenCalledWith(
			expect.objectContaining({
				checked: true,
				checkResults: [
					expect.objectContaining({ status: "codex-available" }),
					expect.objectContaining({ status: "needs-relogin" }),
				],
			}),
		);
		expect(removeAccount).toHaveBeenCalledWith(
			expect.objectContaining({ accountId: "acc_b" }),
		);
		expect(state.info.join("\n")).toContain("Remaining: 1");
	});

	it("supports explicit index removal without a probe when requested", async () => {
		const state = commandState();

		expect(
			await runRemoveCommand(["2", "--yes", "--no-check"], state.deps),
		).toBe(0);
		expect(state.deps.runHealthCheck).not.toHaveBeenCalled();
		expect(state.deps.promptAccount).not.toHaveBeenCalled();
		expect(state.deps.removeAccount).toHaveBeenCalledWith(
			expect.objectContaining({ accountId: "acc_b" }),
		);
	});

	it("requires an index and explicit confirmation outside a TTY", async () => {
		const missingIndex = commandState();
		expect(await runRemoveCommand([], missingIndex.deps)).toBe(1);
		expect(missingIndex.errors.join("\n")).toContain("Missing index");

		const missingYes = commandState();
		expect(await runRemoveCommand(["1"], missingYes.deps)).toBe(1);
		expect(missingYes.errors.join("\n")).toContain("--yes");
		expect(missingYes.deps.removeAccount).not.toHaveBeenCalled();
	});

	it("cancels cleanly when confirmation is declined", async () => {
		const state = commandState({
			isInteractive: () => true,
			confirmRemoval: vi.fn(async () => false),
		});

		expect(
			await runRemoveCommand(["1", "--no-check"], state.deps),
		).toBe(0);
		expect(state.info).toContain("Cancelled.");
		expect(state.deps.removeAccount).not.toHaveBeenCalled();
	});
});
