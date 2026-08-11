import { join } from "node:path";

export const RUNTIME_ROTATION_PROXY_PROVIDER_ID =
	"codex-multi-auth-runtime-proxy" as const;

export const APP_RUNTIME_HELPER_STATUS_FILE =
	"runtime-rotation-app-helper.json" as const;

/** Immutable launcher metadata used to verify ownership before stopping a helper. */
export const APP_RUNTIME_HELPER_OWNER_FILE =
	"runtime-rotation-app-helper-owner.json" as const;

/**
 * Every path a helper status record can live at: the per-PID files
 * (`runtime-rotation-app-helper.<pid>.json`, one per helper) plus the
 * un-suffixed legacy shared path from before the per-PID change, which is
 * still read so a pre-upgrade helper stays visible. The filename contract
 * lives here, next to the constant it derives from, so every reader agrees
 * on it; callers supply the directory listing so this stays pure and their
 * own error handling for the `readdir` stays theirs.
 */
export function listRuntimeHelperStatusPaths(
	baseDir: string,
	entries: readonly string[],
): string[] {
	const prefix = APP_RUNTIME_HELPER_STATUS_FILE.replace(/\.json$/i, "");
	const perPidPattern = new RegExp(
		`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d+\\.json$`,
		"i",
	);
	return [
		...entries
			.filter((name) => perPidPattern.test(name))
			.map((name) => join(baseDir, name)),
		join(baseDir, APP_RUNTIME_HELPER_STATUS_FILE),
	];
}
