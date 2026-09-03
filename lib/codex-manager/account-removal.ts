import { sanitizeEmail } from "../accounts.js";
import { MODEL_FAMILIES } from "../prompts/codex.js";
import {
	type AccountMetadataV3,
	type AccountStorageV3,
	bumpStorageAffinityGeneration,
	findMatchingAccountIndex,
	reconcilePinnedAccountIndex,
	withAccountStorageTransaction,
} from "../storage.js";

type AccountStorageTransaction = <T>(
	handler: (
		current: AccountStorageV3 | null,
		persist: (storage: AccountStorageV3) => Promise<void>,
	) => Promise<T>,
) => Promise<T>;

export interface AccountRemovalDeps {
	withAccountStorageTransaction: AccountStorageTransaction;
}

export type AccountRemovalResult =
	| { removed: false }
	| {
			removed: true;
			removedIndex: number;
			storage: AccountStorageV3;
	  };

const DEFAULT_DEPS: AccountRemovalDeps = {
	withAccountStorageTransaction,
};

function adjustSelectionIndex(
	currentIndex: number | undefined,
	removedIndex: number,
	remainingCount: number,
): number {
	if (remainingCount <= 0) return 0;
	if (typeof currentIndex !== "number" || currentIndex < 0) return 0;
	if (currentIndex < removedIndex) {
		return Math.min(currentIndex, remainingCount - 1);
	}
	if (currentIndex > removedIndex) return currentIndex - 1;
	return Math.min(removedIndex, remainingCount - 1);
}

function resetSelectionAfterRemoval(
	storage: AccountStorageV3,
	removedIndex: number,
): void {
	const remainingCount = storage.accounts.length;
	if (remainingCount <= 0) {
		storage.activeIndex = 0;
		storage.activeIndexByFamily = {};
		for (const family of MODEL_FAMILIES) {
			storage.activeIndexByFamily[family] = 0;
		}
		return;
	}

	const previousActiveIndex = storage.activeIndex;
	const previousByFamily = { ...(storage.activeIndexByFamily ?? {}) };
	storage.activeIndex = adjustSelectionIndex(
		previousActiveIndex,
		removedIndex,
		remainingCount,
	);
	storage.activeIndexByFamily = {};
	for (const family of MODEL_FAMILIES) {
		storage.activeIndexByFamily[family] = adjustSelectionIndex(
			previousByFamily[family] ?? previousActiveIndex,
			removedIndex,
			remainingCount,
		);
	}
}

function matchesSelectedAccount(
	selected: AccountMetadataV3,
	candidate: AccountMetadataV3 | undefined,
): boolean {
	if (!candidate) return false;
	if (selected.accountId || candidate.accountId) {
		return selected.accountId === candidate.accountId;
	}
	return (
		selected.refreshToken === candidate.refreshToken &&
		sanitizeEmail(selected.email) === sanitizeEmail(candidate.email)
	);
}

/**
 * Remove a previously selected account inside the storage transaction.
 *
 * The target is re-resolved by identity after the transaction reload so a
 * concurrent reorder cannot make an index-based delete remove the wrong row.
 * Every positional pointer is then repaired and the affinity generation is
 * bumped so already-running proxies discard stale index bindings.
 */
export async function removeAccountFromStorage(
	selected: AccountMetadataV3,
	deps: AccountRemovalDeps = DEFAULT_DEPS,
): Promise<AccountRemovalResult> {
	return deps.withAccountStorageTransaction(async (current, persist) => {
		if (!current || current.accounts.length === 0) {
			return { removed: false };
		}

		const nextStorage = structuredClone(current);
		const targetIndex = findMatchingAccountIndex(
			nextStorage.accounts,
			{
				accountId: selected.accountId,
				email: selected.email,
				refreshToken: selected.refreshToken,
			},
			{ allowUniqueAccountIdFallbackWithoutEmail: true },
		);
		if (targetIndex === undefined) {
			return { removed: false };
		}

		const target = nextStorage.accounts[targetIndex];
		if (!matchesSelectedAccount(selected, target)) {
			return { removed: false };
		}

		const pinnedAccount =
			typeof nextStorage.pinnedAccountIndex === "number"
				? nextStorage.accounts[nextStorage.pinnedAccountIndex]
				: undefined;
		nextStorage.accounts.splice(targetIndex, 1);
		resetSelectionAfterRemoval(nextStorage, targetIndex);
		const nextPinnedIndex = reconcilePinnedAccountIndex(
			pinnedAccount,
			nextStorage.accounts,
		);
		if (nextPinnedIndex === undefined) {
			delete nextStorage.pinnedAccountIndex;
		} else {
			nextStorage.pinnedAccountIndex = nextPinnedIndex;
		}
		bumpStorageAffinityGeneration(nextStorage);
		await persist(nextStorage);

		return {
			removed: true,
			removedIndex: targetIndex,
			storage: nextStorage,
		};
	});
}
