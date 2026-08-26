import { describe, expect, it, vi } from "vitest";
import {
	CodexAuthJsonParseError,
	parseCodexAuthJson,
	type ParsedCodexAuthJsonAccount,
} from "../lib/auth/auth-json.js";
import {
	AuthJsonInputCancelledError,
	inspectJsonObjectCompletion,
} from "../lib/codex-manager/auth-json-input.js";
import {
	type AddCommandDeps,
	parseAddArgs,
	type PersistImportedAuthJsonDeps,
	persistImportedAuthJsonAccount,
	runAddCommand,
} from "../lib/codex-manager/commands/add.js";
import { ACCOUNT_LIMITS, JWT_CLAIM_PATH } from "../lib/constants.js";
import {
	findMatchingAccountIndex,
	type AccountMetadataV3,
	type AccountStorageV3,
} from "../lib/storage.js";

const NOW = 1_800_000_000_000;

function syntheticJwt(payload: Record<string, unknown>): string {
	const header = Buffer.from(
		JSON.stringify({ alg: "none", typ: "JWT" }),
	).toString("base64url");
	const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
	return `${header}.${body}.synthetic-signature`;
}

function authJson(overrides: {
	accessToken?: string;
	refreshToken?: string;
	idToken?: string;
	accountId?: string;
	email?: string;
	authMode?: string;
} = {}): string {
	return JSON.stringify({
		auth_mode: overrides.authMode ?? "chatgpt",
		tokens: {
			access_token:
				overrides.accessToken ??
				syntheticJwt({
					exp: Math.floor((NOW + 3_600_000) / 1000),
					[JWT_CLAIM_PATH]: { chatgpt_account_id: "acc_personal" },
				}),
			refresh_token: overrides.refreshToken ?? "synthetic-refresh-token",
			id_token:
				overrides.idToken ??
				syntheticJwt({
					email: "User@Example.com",
					organizations: [
						{ id: "org_team", name: "Team", is_default: true },
					],
				}),
			account_id: overrides.accountId ?? "org_team",
		},
		_meta: {
			email: overrides.email ?? "meta@example.com",
			plan_type: "team",
		},
	});
}

function parsedAccount(
	overrides: Partial<ParsedCodexAuthJsonAccount> = {},
): ParsedCodexAuthJsonAccount {
	return {
		accountId: "acc_imported",
		accountIdSource: "manual",
		email: "imported@example.com",
		refreshToken: "refresh-imported",
		accessToken: "access-imported",
		expiresAt: NOW + 3_600_000,
		...overrides,
	};
}

function storedAccount(index: number): AccountMetadataV3 {
	return {
		accountId: `acc_${index}`,
		accountIdSource: "token",
		email: `user${index}@example.com`,
		refreshToken: `refresh-${index}`,
		accessToken: `access-${index}`,
		expiresAt: NOW + 3_600_000,
		enabled: true,
		addedAt: NOW - 10_000,
		lastUsed: NOW - 10_000,
	};
}

function persistenceDeps(
	current: AccountStorageV3 | null,
	onPersist: (storage: AccountStorageV3) => void,
): PersistImportedAuthJsonDeps {
	return {
		withAccountStorageTransaction: async (handler) =>
			handler(current, async (storage) => onPersist(structuredClone(storage))),
		findMatchingAccountIndex,
		now: () => NOW,
	};
}

function commandDeps(overrides: Partial<AddCommandDeps> = {}): {
	deps: AddCommandDeps;
	info: string[];
	warnings: string[];
	errors: string[];
} {
	const info: string[] = [];
	const warnings: string[] = [];
	const errors: string[] = [];
	const deps: AddCommandDeps = {
		setStoragePath: vi.fn(),
		isInteractive: () => false,
		promptSource: async () => "cancel",
		promptPath: async () => null,
		getDefaultAuthPath: () => "/mock/.codex/auth.json",
		resolvePath: (path) => `/resolved/${path}`,
		readFile: async () => authJson(),
		readRaw: async () => authJson(),
		parse: parseCodexAuthJson,
		persist: async () => ({ outcome: "inserted", total: 1 }),
		now: () => NOW,
		logInfo: (message) => info.push(message),
		logWarn: (message) => warnings.push(message),
		logError: (message) => errors.push(message),
		...overrides,
	};
	return { deps, info, warnings, errors };
}

describe("auth.json parser", () => {
	it("extracts credentials, selected workspace, email, and expiry", () => {
		const parsed = parseCodexAuthJson(authJson());

		expect(parsed.accountId).toBe("org_team");
		expect(parsed.accountIdSource).toBe("org");
		expect(parsed.email).toBe("user@example.com");
		expect(parsed.expiresAt).toBe(NOW + 3_600_000);
		expect(parsed.workspaces?.map((workspace) => workspace.id)).toEqual([
			"acc_personal",
			"org_team",
		]);
	});

	it("accepts a BOM, unknown fields, opaque access token, and metadata email fallback", () => {
		const raw = JSON.stringify({
			auth_mode: "chatgpt",
			tokens: {
				access_token: "opaque-access-token",
				refresh_token: "opaque-refresh-token",
				account_id: "workspace_from_file",
				future_field: true,
			},
			_meta: { email: "Meta@Example.com", future_meta: 1 },
			future_root: { enabled: true },
		});
		const parsed = parseCodexAuthJson(`\uFEFF${raw}`);

		expect(parsed.expiresAt).toBeUndefined();
		expect(parsed.email).toBe("meta@example.com");
		expect(parsed.accountId).toBe("workspace_from_file");
		expect(parsed.accountIdSource).toBe("manual");
		expect(parsed.workspaces).toEqual([
			expect.objectContaining({ id: "workspace_from_file", isDefault: true }),
		]);
	});

	it("rejects malformed, incomplete, and non-ChatGPT payloads without leaking tokens", () => {
		const secret = "secret-refresh-value";
		for (const raw of [
			`{"tokens":{"refresh_token":"${secret}"`,
			JSON.stringify({ auth_mode: "apikey", tokens: {} }),
			JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: secret } }),
		]) {
			let caught: unknown;
			try {
				parseCodexAuthJson(raw);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(CodexAuthJsonParseError);
			expect(String(caught)).not.toContain(secret);
		}
	});
});

describe("hidden raw JSON completion scanner", () => {
	it("waits for the complete root object and ignores braces in strings", () => {
		expect(inspectJsonObjectCompletion('{"nested":{"value":"}"}')).toEqual({
			kind: "incomplete",
		});
		expect(
			inspectJsonObjectCompletion('{"nested":{"value":"}"}}\n'),
		).toEqual({ kind: "complete", endIndex: 24 });
	});

	it("rejects a non-object root", () => {
		expect(inspectJsonObjectCompletion("[1,2,3]")).toEqual({ kind: "invalid" });
	});
});

describe("add argument parser", () => {
	it("supports interactive, path, equals-path, and raw sources", () => {
		expect(parseAddArgs([])).toEqual({
			ok: true,
			source: { type: "interactive" },
		});
		expect(parseAddArgs(["--auth-json", "./auth.json"])).toEqual({
			ok: true,
			source: { type: "path", path: "./auth.json" },
		});
		expect(parseAddArgs(["--auth-json=./auth.json"])).toEqual({
			ok: true,
			source: { type: "path", path: "./auth.json" },
		});
		expect(parseAddArgs(["--raw-auth-json"])).toEqual({
			ok: true,
			source: { type: "raw" },
		});
	});

	it("rejects missing paths, unknown flags, and multiple sources", () => {
		expect(parseAddArgs(["--auth-json"])).toMatchObject({
			ok: false,
			reason: "error",
		});
		expect(parseAddArgs(["--unknown"])).toMatchObject({
			ok: false,
			reason: "error",
		});
		expect(
			parseAddArgs(["--raw-auth-json", "--auth-json", "auth.json"]),
		).toMatchObject({ ok: false, reason: "error" });
	});
});

describe("auth.json account persistence", () => {
	it("appends without changing active, family, pin, or affinity state", async () => {
		const current: AccountStorageV3 = {
			version: 3,
			accounts: [storedAccount(0), storedAccount(1)],
			activeIndex: 1,
			activeIndexByFamily: { codex: 1, "gpt-5.1": 0 },
			pinnedAccountIndex: 1,
			affinityGeneration: 7,
		};
		const persisted: AccountStorageV3[] = [];

		const result = await persistImportedAuthJsonAccount(
			parsedAccount(),
			persistenceDeps(current, (storage) => {
				persisted.push(storage);
			}),
		);

		expect(result).toEqual({ outcome: "inserted", total: 3 });
		expect(persisted[0]).toMatchObject({
			activeIndex: 1,
			activeIndexByFamily: { codex: 1, "gpt-5.1": 0 },
			pinnedAccountIndex: 1,
			affinityGeneration: 7,
		});
		expect(persisted[0]?.accounts[2]?.accountId).toBe("acc_imported");
	});

	it("updates and re-enables a matching account without moving selection", async () => {
		const existing = storedAccount(0);
		existing.enabled = false;
		const current: AccountStorageV3 = {
			version: 3,
			accounts: [existing, storedAccount(1)],
			activeIndex: 1,
			activeIndexByFamily: { codex: 1 },
		};
		const persisted: AccountStorageV3[] = [];

		const result = await persistImportedAuthJsonAccount(
			parsedAccount({
				accountId: existing.accountId,
				email: existing.email,
				refreshToken: "refresh-replaced",
				accessToken: "access-replaced",
			}),
			persistenceDeps(current, (storage) => {
				persisted.push(storage);
			}),
		);

		expect(result.outcome).toBe("updated");
		expect(persisted[0]?.activeIndex).toBe(1);
		expect(persisted[0]?.accounts[0]).toMatchObject({
			refreshToken: "refresh-replaced",
			accessToken: "access-replaced",
			enabled: true,
		});
	});

	it("enforces the account cap after dedup and never persists an overflow", async () => {
		const current: AccountStorageV3 = {
			version: 3,
			accounts: Array.from(
				{ length: ACCOUNT_LIMITS.MAX_ACCOUNTS },
				(_, index) => storedAccount(index),
			),
			activeIndex: 0,
		};
		const onPersist = vi.fn();

		await expect(
			persistImportedAuthJsonAccount(
				parsedAccount(),
				persistenceDeps(current, onPersist),
			),
		).rejects.toThrow(`maximum of ${ACCOUNT_LIMITS.MAX_ACCOUNTS}`);
		expect(onPersist).not.toHaveBeenCalled();

		await expect(
			persistImportedAuthJsonAccount(
				parsedAccount({
					accountId: current.accounts[0]?.accountId,
					email: current.accounts[0]?.email,
				}),
				persistenceDeps(current, onPersist),
			),
		).resolves.toMatchObject({ outcome: "updated", total: ACCOUNT_LIMITS.MAX_ACCOUNTS });
		expect(onPersist).toHaveBeenCalledTimes(1);
	});
});

describe("add command", () => {
	it("imports from a resolved path and leaves selection synchronization alone", async () => {
		const readFile = vi.fn(async () => authJson());
		const persist = vi.fn(async () => ({
			outcome: "inserted" as const,
			total: 3,
		}));
		const state = commandDeps({ readFile, persist });

		expect(
			await runAddCommand(["--auth-json", "auth.json"], state.deps),
		).toBe(0);
		expect(readFile).toHaveBeenCalledWith("/resolved/auth.json");
		expect(persist).toHaveBeenCalledTimes(1);
		expect(state.info).toContain("Added account from auth.json. Total: 3");
		expect(state.info).toContain(
			"Existing selection and official Codex auth state were not changed.",
		);
	});

	it("reads raw input and safely warns about missing expiry", async () => {
		const state = commandDeps({
			readRaw: async () => authJson({ accessToken: "opaque-access" }),
		});

		expect(await runAddCommand(["--raw-auth-json"], state.deps)).toBe(0);
		expect(state.warnings.join("\n")).toContain("no readable expiry");
	});

	it("requires an explicit source outside a TTY", async () => {
		const state = commandDeps();
		expect(await runAddCommand([], state.deps)).toBe(1);
		expect(state.errors.join("\n")).toContain("Missing auth.json source");
	});

	it("treats hidden-paste cancellation as a clean exit", async () => {
		const state = commandDeps({
			readRaw: async () => {
				throw new AuthJsonInputCancelledError();
			},
		});
		expect(await runAddCommand(["--raw-auth-json"], state.deps)).toBe(0);
		expect(state.info).toContain("Cancelled.");
		expect(state.errors).toEqual([]);
	});

	it("never echoes secrets from malformed raw JSON", async () => {
		const secret = "never-print-this-refresh-token";
		const state = commandDeps({
			readRaw: async () => `{"tokens":{"refresh_token":"${secret}"`,
		});

		expect(await runAddCommand(["--raw-auth-json"], state.deps)).toBe(1);
		expect(state.errors.join("\n")).not.toContain(secret);
	});
});
