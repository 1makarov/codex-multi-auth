import { stdin as input, stdout as output } from "node:process";
import {
	parseCodexAuthJson,
	type ParsedCodexAuthJsonAccount,
} from "../../auth/auth-json.js";
import { getCodexCliAuthPath } from "../../codex-cli/state.js";
import { ACCOUNT_LIMITS } from "../../constants.js";
import { MODEL_FAMILIES, type ModelFamily } from "../../prompts/codex.js";
import {
	findMatchingAccountIndex,
	setStoragePath,
	type AccountStorageV3,
	withAccountStorageTransaction,
} from "../../storage.js";
import { resolvePath } from "../../storage/paths.js";
import {
	AuthJsonInputCancelledError,
	promptAuthJsonInputSource,
	promptAuthJsonPath,
	readAuthJsonFileContent,
	readRawAuthJsonInput,
} from "../auth-json-input.js";
import {
	applyAccountPoolResults,
	type AccountPoolWriteOutcome,
	type ResolvedAccountWrite,
} from "../account-pool-write.js";

export type AddAuthJsonSource =
	| { type: "interactive" }
	| { type: "prompt-path" }
	| { type: "path"; path: string }
	| { type: "raw" };

export type ParsedAddArgs =
	| { ok: true; source: AddAuthJsonSource }
	| { ok: false; reason: "help" }
	| { ok: false; reason: "error"; message: string };

export interface ImportedAuthJsonResult {
	outcome: AccountPoolWriteOutcome;
	total: number;
}

type AccountStorageTransaction = <T>(
	handler: (
		current: AccountStorageV3 | null,
		persist: (storage: AccountStorageV3) => Promise<void>,
	) => Promise<T>,
) => Promise<T>;

type MatchAccountIndex = Parameters<
	typeof applyAccountPoolResults
>[0]["findMatchingAccountIndex"];

export interface PersistImportedAuthJsonDeps {
	withAccountStorageTransaction: AccountStorageTransaction;
	findMatchingAccountIndex: MatchAccountIndex;
	now: () => number;
}

export interface AddCommandDeps {
	setStoragePath: (path: string | null) => void;
	isInteractive: () => boolean;
	promptSource: typeof promptAuthJsonInputSource;
	promptPath: typeof promptAuthJsonPath;
	getDefaultAuthPath: () => string;
	resolvePath: (path: string) => string;
	readFile: typeof readAuthJsonFileContent;
	readRaw: typeof readRawAuthJsonInput;
	parse: typeof parseCodexAuthJson;
	persist: (
		account: ParsedCodexAuthJsonAccount,
	) => Promise<ImportedAuthJsonResult>;
	now: () => number;
	logInfo: (message: string) => void;
	logWarn: (message: string) => void;
	logError: (message: string) => void;
}

const DEFAULT_PERSIST_DEPS: PersistImportedAuthJsonDeps = {
	withAccountStorageTransaction,
	findMatchingAccountIndex,
	now: () => Date.now(),
};

const DEFAULT_DEPS: AddCommandDeps = {
	setStoragePath,
	isInteractive: () => Boolean(input.isTTY && output.isTTY),
	promptSource: promptAuthJsonInputSource,
	promptPath: promptAuthJsonPath,
	getDefaultAuthPath: getCodexCliAuthPath,
	resolvePath,
	readFile: readAuthJsonFileContent,
	readRaw: readRawAuthJsonInput,
	parse: parseCodexAuthJson,
	persist: (account) => persistImportedAuthJsonAccount(account),
	now: () => Date.now(),
	logInfo: console.log,
	logWarn: console.warn,
	logError: console.error,
};

export function printAddUsage(log: (message: string) => void = console.log): void {
	log(
		[
			"Usage:",
			"  codex-multi-auth add",
			"  codex-multi-auth add --auth-json <path>",
			"  codex-multi-auth add --raw-auth-json",
			"",
			"Options:",
			"  --auth-json <path>  Read an official Codex ChatGPT auth.json file",
			"  --raw-auth-json     Paste raw JSON in a TTY, or read it from stdin",
			"  --help, -h          Show this help",
			"",
			"The account is added or updated without changing the current selection",
			"or writing the official ~/.codex/auth.json state.",
		].join("\n"),
	);
}

export function parseAddArgs(args: string[]): ParsedAddArgs {
	let source: AddAuthJsonSource = { type: "interactive" };
	let sourceWasSet = false;

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") {
			return { ok: false, reason: "help" };
		}
		if (arg === "--raw-auth-json") {
			if (sourceWasSet) {
				return {
					ok: false,
					reason: "error",
					message: "Choose exactly one auth.json source",
				};
			}
			source = { type: "raw" };
			sourceWasSet = true;
			continue;
		}
		if (arg === "--auth-json" || arg?.startsWith("--auth-json=")) {
			if (sourceWasSet) {
				return {
					ok: false,
					reason: "error",
					message: "Choose exactly one auth.json source",
				};
			}
			const value =
				arg === "--auth-json"
					? args[index + 1]
					: arg.slice("--auth-json=".length);
			if (arg === "--auth-json") index += 1;
			const path = value?.trim();
			if (!path || path.startsWith("--")) {
				return {
					ok: false,
					reason: "error",
					message:
						"Missing path. Usage: codex-multi-auth add --auth-json <path>",
				};
			}
			source = { type: "path", path };
			sourceWasSet = true;
			continue;
		}
		return {
			ok: false,
			reason: "error",
			message: `Unknown add option: ${arg}`,
		};
	}

	return { ok: true, source };
}

function buildInitialFamilyIndexes(): Partial<Record<ModelFamily, number>> {
	const indexes: Partial<Record<ModelFamily, number>> = {};
	for (const family of MODEL_FAMILIES) indexes[family] = 0;
	return indexes;
}

/**
 * Fold one parsed auth.json account into canonical storage without selecting
 * it. Appending/updating does not reorder existing rows, so every positional
 * selection and pin remains valid and can be copied verbatim.
 */
export async function persistImportedAuthJsonAccount(
	account: ParsedCodexAuthJsonAccount,
	deps: PersistImportedAuthJsonDeps = DEFAULT_PERSIST_DEPS,
): Promise<ImportedAuthJsonResult> {
	return deps.withAccountStorageTransaction(async (current, persist) => {
		const now = deps.now();
		const write: ResolvedAccountWrite = {
			accountId: account.accountId,
			accountIdSource: account.accountIdSource,
			accountLabel: account.accountLabel,
			email: account.email,
			refreshToken: account.refreshToken,
			accessToken: account.accessToken,
			expiresAt: account.expiresAt,
			workspaces: account.workspaces,
			now,
		};
		const result = applyAccountPoolResults({
			existing: current?.accounts ?? [],
			writes: [write],
			priorActiveIndex: current?.activeIndex,
			findMatchingAccountIndex: deps.findMatchingAccountIndex,
		});
		if (!result.outcome) {
			throw new Error("auth.json did not contain an importable account");
		}
		if (result.accounts.length > ACCOUNT_LIMITS.MAX_ACCOUNTS) {
			throw new Error(
				`Adding this account would exceed the maximum of ${ACCOUNT_LIMITS.MAX_ACCOUNTS} accounts`,
			);
		}

		const nextStorage: AccountStorageV3 = current
			? {
					...current,
					accounts: result.accounts,
					activeIndexByFamily: current.activeIndexByFamily
						? { ...current.activeIndexByFamily }
						: current.activeIndexByFamily,
				}
			: {
					version: 3,
					accounts: result.accounts,
					activeIndex: 0,
					activeIndexByFamily: buildInitialFamilyIndexes(),
				};
		await persist(nextStorage);
		return { outcome: result.outcome, total: result.accounts.length };
	});
}

function formatOutcome(result: ImportedAuthJsonResult): string {
	if (result.outcome === "updated") {
		return `Updated existing account from auth.json. Total: ${result.total}`;
	}
	if (result.outcome === "rebound") {
		return `Rebound workspace for existing account from auth.json. Total: ${result.total}`;
	}
	return `Added account from auth.json. Total: ${result.total}`;
}

export async function runAddCommand(
	args: string[],
	deps: AddCommandDeps = DEFAULT_DEPS,
): Promise<number> {
	const parsedArgs = parseAddArgs(args);
	if (!parsedArgs.ok) {
		if (parsedArgs.reason === "help") {
			printAddUsage(deps.logInfo);
			return 0;
		}
		deps.logError(parsedArgs.message);
		printAddUsage(deps.logError);
		return 1;
	}

	deps.setStoragePath(null);
	let source = parsedArgs.source;
	try {
		if (source.type === "interactive") {
			if (!deps.isInteractive()) {
				deps.logError(
					"Missing auth.json source in non-interactive mode. Use --auth-json <path> or --raw-auth-json.",
				);
				return 1;
			}
			const selected = await deps.promptSource();
			if (selected === "cancel") {
				deps.logInfo("Cancelled.");
				return 0;
			}
			source =
				selected === "path" ? { type: "prompt-path" } : { type: "raw" };
		}

		let raw: string;
		if (source.type === "path") {
			raw = await deps.readFile(deps.resolvePath(source.path));
		} else if (source.type === "raw") {
			raw = await deps.readRaw();
		} else {
			const selectedPath = await deps.promptPath(deps.getDefaultAuthPath());
			if (!selectedPath) {
				deps.logInfo("Cancelled.");
				return 0;
			}
			raw = await deps.readFile(deps.resolvePath(selectedPath));
		}

		const account = deps.parse(raw);
		const result = await deps.persist(account);
		deps.logInfo(formatOutcome(result));
		deps.logInfo(
			"Existing selection and official Codex auth state were not changed.",
		);
		if (account.expiresAt === undefined) {
			deps.logWarn(
				"Imported access token has no readable expiry. Run `codex-multi-auth check` before use.",
			);
		} else if (account.expiresAt <= deps.now()) {
			deps.logWarn(
				"Imported access token is expired. Run `codex-multi-auth check` to refresh and verify it.",
			);
		}
		return 0;
	} catch (error) {
		if (error instanceof AuthJsonInputCancelledError) {
			deps.logInfo("Cancelled.");
			return 0;
		}
		const message = error instanceof Error ? error.message : "unknown error";
		deps.logError(`Failed to add account from auth.json: ${message}`);
		return 1;
	}
}
