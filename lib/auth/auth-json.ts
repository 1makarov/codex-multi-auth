import { decodeJWT } from "./auth.js";
import {
	extractAccountEmail,
	getAccountIdCandidates,
	sanitizeEmail,
	selectBestAccountCandidate,
} from "./token-utils.js";
import {
	CodexAuthJsonSchema,
	type CodexAuthJsonFromSchema,
} from "../schemas.js";
import type { AccountIdSource } from "../types.js";
import type { Workspace } from "../storage/public-types.js";

export interface ParsedCodexAuthJsonAccount {
	accessToken: string;
	refreshToken: string;
	idToken?: string;
	expiresAt?: number;
	accountId?: string;
	accountIdSource?: AccountIdSource;
	accountLabel?: string;
	email?: string;
	workspaces?: Workspace[];
}

export class CodexAuthJsonParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodexAuthJsonParseError";
	}
}

function stripUtf8Bom(raw: string): string {
	return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

function parseJsonObject(raw: string): unknown {
	const normalized = stripUtf8Bom(raw);
	if (normalized.trim().length === 0) {
		throw new CodexAuthJsonParseError("auth.json is empty");
	}
	try {
		return JSON.parse(normalized) as unknown;
	} catch {
		// Native JSON.parse messages may quote nearby source text. Never surface
		// them because nearby text can contain an access or refresh token.
		throw new CodexAuthJsonParseError("auth.json contains malformed JSON");
	}
}

function validateAuthJson(value: unknown): CodexAuthJsonFromSchema {
	if (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		"auth_mode" in value &&
		(value as { auth_mode?: unknown }).auth_mode !== undefined &&
		(value as { auth_mode?: unknown }).auth_mode !== "chatgpt"
	) {
		throw new CodexAuthJsonParseError(
			"Unsupported auth_mode; only ChatGPT OAuth auth.json files are supported",
		);
	}

	const parsed = CodexAuthJsonSchema.safeParse(value);
	if (parsed.success) return parsed.data;

	const paths = [
		...new Set(
			parsed.error.issues.map((issue) =>
				issue.path.length > 0 ? issue.path.join(".") : "root",
			),
		),
	].slice(0, 4);
	throw new CodexAuthJsonParseError(
		`Invalid auth.json structure (${paths.join(", ")})`,
	);
}

function readAccessTokenExpiry(accessToken: string): number | undefined {
	const decoded = decodeJWT(accessToken);
	const exp = decoded?.exp;
	if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) {
		return undefined;
	}
	return exp * 1000;
}

/**
 * Parse one official Codex ChatGPT auth.json payload into a single account
 * import record. This is deliberately offline: JWT payloads are decoded only
 * for identity/expiry hints and their signatures are not verified here.
 */
export function parseCodexAuthJson(raw: string): ParsedCodexAuthJsonAccount {
	const parsed = validateAuthJson(parseJsonObject(raw));
	const accessToken = parsed.tokens.access_token;
	const refreshToken = parsed.tokens.refresh_token;
	const idToken = parsed.tokens.id_token;
	const candidates = getAccountIdCandidates(accessToken, idToken);
	const requestedAccountId = parsed.tokens.account_id;
	const selectedCandidate = requestedAccountId
		? candidates.find((candidate) => candidate.accountId === requestedAccountId)
		: selectBestAccountCandidate(candidates);
	const accountId = requestedAccountId ?? selectedCandidate?.accountId;
	const accountIdSource: AccountIdSource | undefined = requestedAccountId
		? (selectedCandidate?.source ?? "manual")
		: selectedCandidate?.source;
	const email = sanitizeEmail(
		extractAccountEmail(accessToken, idToken) ??
			parsed.email ??
			parsed._meta?.email,
	);
	const expiresAt = readAccessTokenExpiry(accessToken);
	const workspaces: Workspace[] = candidates.map((candidate) => ({
		id: candidate.accountId,
		name: candidate.label,
		enabled: true,
		isDefault: candidate.isDefault,
	}));
	if (
		requestedAccountId &&
		!workspaces.some((workspace) => workspace.id === requestedAccountId)
	) {
		const suffix =
			requestedAccountId.length > 6
				? requestedAccountId.slice(-6)
				: requestedAccountId;
		workspaces.push({
			id: requestedAccountId,
			name: `Imported workspace [id:${suffix}]`,
			enabled: true,
			isDefault: true,
		});
	}

	return {
		accessToken,
		refreshToken,
		...(idToken ? { idToken } : {}),
		...(expiresAt !== undefined ? { expiresAt } : {}),
		...(accountId ? { accountId } : {}),
		...(accountIdSource ? { accountIdSource } : {}),
		...(selectedCandidate?.label
			? { accountLabel: selectedCandidate.label }
			: {}),
		...(email ? { email } : {}),
		...(workspaces.length > 0 ? { workspaces } : {}),
	};
}
