import { stdin as input, stdout as output } from "node:process";
import { formatAccountLabel, sanitizeEmail } from "../../accounts.js";
import {
	type AccountMetadataV3,
	type AccountStorageV3,
	loadAccounts,
	setStoragePath,
} from "../../storage.js";
import { confirm } from "../../ui/confirm.js";
import { getUiRuntimeOptions } from "../../ui/runtime.js";
import { select, type MenuItem } from "../../ui/select.js";
import { UI_COPY } from "../../ui/ui-copy.js";
import {
	type AccountRemovalResult,
	removeAccountFromStorage,
} from "../account-removal.js";
import {
	type HealthCheckAccountResult,
	type HealthCheckOptions,
	runHealthCheck,
} from "../health-check.js";

export interface RemoveCommandOptions {
	index?: number;
	yes: boolean;
	runCheck: boolean;
}

export type ParsedRemoveArgs =
	| { ok: true; options: RemoveCommandOptions }
	| { ok: false; reason: "help" }
	| { ok: false; reason: "error"; message: string };

export interface RemoveAccountPromptInput {
	accounts: readonly AccountMetadataV3[];
	checkResults: readonly HealthCheckAccountResult[];
	checked: boolean;
}

export interface RemoveCommandDeps {
	setStoragePath: (path: string | null) => void;
	loadAccounts: () => Promise<AccountStorageV3 | null>;
	runHealthCheck: (options: HealthCheckOptions) => Promise<void>;
	isInteractive: () => boolean;
	promptAccount: (input: RemoveAccountPromptInput) => Promise<number | null>;
	confirmRemoval: (message: string) => Promise<boolean>;
	removeAccount: (account: AccountMetadataV3) => Promise<AccountRemovalResult>;
	logInfo: (message: string) => void;
	logError: (message: string) => void;
}

const DEFAULT_DEPS: RemoveCommandDeps = {
	setStoragePath,
	loadAccounts,
	runHealthCheck,
	isInteractive: () => Boolean(input.isTTY && output.isTTY),
	promptAccount: promptRemoveAccount,
	confirmRemoval: (message) => confirm(message),
	removeAccount: (account) => removeAccountFromStorage(account),
	logInfo: console.log,
	logError: console.error,
};

export function printRemoveUsage(
	log: (message: string) => void = console.log,
): void {
	log(
		[
			"Usage:",
			"  codex-multi-auth remove",
			"  codex-multi-auth remove <index> [--yes] [--no-check]",
			"",
			"Options:",
			"  --yes, -y     Skip the confirmation prompt",
			"  --no-check    Skip the live account check before choosing/removing",
			"  --help, -h    Show this help",
			"",
			"Without an index, an interactive menu shows the live statuses from",
			"`codex-multi-auth check` before you choose an account to remove.",
			"Only multi-auth storage is changed; official Codex auth state is untouched.",
		].join("\n"),
	);
}

export function parseRemoveArgs(args: string[]): ParsedRemoveArgs {
	let index: number | undefined;
	let yes = false;
	let runCheck = true;

	for (const arg of args) {
		if (arg === "--help" || arg === "-h") {
			return { ok: false, reason: "help" };
		}
		if (arg === "--yes" || arg === "-y") {
			yes = true;
			continue;
		}
		if (arg === "--no-check") {
			runCheck = false;
			continue;
		}
		if (arg.startsWith("-")) {
			return {
				ok: false,
				reason: "error",
				message: `Unknown remove option: ${arg}`,
			};
		}
		if (index !== undefined) {
			return {
				ok: false,
				reason: "error",
				message: "Choose exactly one account index to remove",
			};
		}
		if (!/^\d+$/.test(arg.trim())) {
			return {
				ok: false,
				reason: "error",
				message: `Invalid account index: ${arg}`,
			};
		}
		const parsed = Number.parseInt(arg, 10);
		if (!Number.isSafeInteger(parsed) || parsed < 1) {
			return {
				ok: false,
				reason: "error",
				message: `Invalid account index: ${arg}`,
			};
		}
		index = parsed;
	}

	return { ok: true, options: { index, yes, runCheck } };
}

function checkStatusLabel(
	result: HealthCheckAccountResult | undefined,
	checked: boolean,
): string {
	if (!checked) return "not checked";
	switch (result?.status) {
		case "codex-available":
			return "Codex available";
		case "signed-in-only":
			return "signed in only";
		case "needs-relogin":
			return "need re-login";
		case "working":
			return "working";
		case "warning":
			return "warning";
		default:
			return "unknown";
	}
}

function checkStatusColor(
	result: HealthCheckAccountResult | undefined,
): MenuItem<number | null>["color"] {
	switch (result?.status) {
		case "codex-available":
		case "working":
			return "green";
		case "signed-in-only":
		case "warning":
			return "yellow";
		case "needs-relogin":
			return "red";
		default:
			return "yellow";
	}
}

function findCheckResult(
	account: AccountMetadataV3,
	index: number,
	results: readonly HealthCheckAccountResult[],
): HealthCheckAccountResult | undefined {
	if (account.recordId) {
		const byRecordId = results.find(
			(result) => result.recordId === account.recordId,
		);
		if (byRecordId) return byRecordId;
	}
	const emailKey = sanitizeEmail(account.email);
	const byIdentity = results.filter(
		(result) =>
			Boolean(account.accountId) &&
			result.accountId === account.accountId &&
			sanitizeEmail(result.email) === emailKey,
	);
	if (byIdentity.length === 1) return byIdentity[0];
	return results.find((result) => result.index === index);
}

export async function promptRemoveAccount({
	accounts,
	checkResults,
	checked,
}: RemoveAccountPromptInput): Promise<number | null> {
	const items: MenuItem<number | null>[] = accounts.map((account, index) => {
		const result = findCheckResult(account, index, checkResults);
		return {
			label: `${formatAccountLabel(account, index)} [${checkStatusLabel(result, checked)}]`,
			hint: result?.detail,
			color: checkStatusColor(result),
			value: index,
		};
	});
	items.push({
		label: UI_COPY.accountRemoval.back,
		value: null,
		color: "red",
	});

	const selected = await select(items, {
		message: UI_COPY.accountRemoval.title,
		subtitle: checked
			? UI_COPY.accountRemoval.subtitle
			: UI_COPY.accountRemoval.skippedSubtitle,
		help: UI_COPY.accountRemoval.help,
		clearScreen: true,
		selectedEmphasis: "minimal",
		showHintsForUnselected: true,
		allowEscape: false,
		theme: getUiRuntimeOptions().theme,
		onInput: (raw) => (raw.toLowerCase() === "q" ? null : undefined),
	});

	return selected;
}

export async function runRemoveCommand(
	args: string[],
	deps: RemoveCommandDeps = DEFAULT_DEPS,
): Promise<number> {
	const parsed = parseRemoveArgs(args);
	if (!parsed.ok) {
		if (parsed.reason === "help") {
			printRemoveUsage(deps.logInfo);
			return 0;
		}
		deps.logError(parsed.message);
		printRemoveUsage(deps.logError);
		return 1;
	}

	const { options } = parsed;
	const interactive = deps.isInteractive();
	if (options.index === undefined && !interactive) {
		deps.logError(
			"Missing index in non-interactive mode. Usage: codex-multi-auth remove <index> --yes",
		);
		return 1;
	}
	if (!interactive && !options.yes) {
		deps.logError(
			"Confirmation requires a TTY. Re-run with --yes to remove this account.",
		);
		return 1;
	}

	deps.setStoragePath(null);
	let storage = await deps.loadAccounts();
	if (!storage || storage.accounts.length === 0) {
		deps.logError("No accounts configured.");
		return 1;
	}

	const checkResults: HealthCheckAccountResult[] = [];
	if (options.runCheck) {
		try {
			await deps.runHealthCheck({
				liveProbe: true,
				syncActiveAccount: false,
				onAccountResult: (result) => checkResults.push(result),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			deps.logError(`Account check failed: ${message}`);
			deps.logError("No account was removed. Re-run with --no-check to skip the check.");
			return 1;
		}

		storage = await deps.loadAccounts();
		if (!storage || storage.accounts.length === 0) {
			deps.logError("No accounts configured.");
			return 1;
		}
	}

	let targetIndex: number;
	if (options.index === undefined) {
		const selected = await deps.promptAccount({
			accounts: storage.accounts,
			checkResults,
			checked: options.runCheck,
		});
		if (selected === null) {
			deps.logInfo("Cancelled.");
			return 0;
		}
		targetIndex = selected;
	} else {
		targetIndex = options.index - 1;
	}

	if (targetIndex < 0 || targetIndex >= storage.accounts.length) {
		deps.logError(
			`Index out of range. Valid range: 1-${storage.accounts.length}`,
		);
		return 1;
	}
	const account = storage.accounts[targetIndex];
	if (!account) {
		deps.logError(`Account ${targetIndex + 1} not found.`);
		return 1;
	}

	if (
		!options.yes &&
		!(await deps.confirmRemoval(
			`Remove ${formatAccountLabel(account, targetIndex)} from multi-auth storage?`,
		))
	) {
		deps.logInfo("Cancelled.");
		return 0;
	}

	const result = await deps.removeAccount(account);
	if (!result.removed) {
		deps.logError(
			"The selected account changed or no longer exists. No account was removed.",
		);
		return 1;
	}

	deps.logInfo(
		`Removed ${formatAccountLabel(account, result.removedIndex)}. Remaining: ${result.storage.accounts.length}`,
	);
	deps.logInfo("Official Codex auth state was not changed.");
	return 0;
}
