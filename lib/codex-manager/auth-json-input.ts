import { promises as fs } from "node:fs";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { StringDecoder } from "node:string_decoder";
import { getUiRuntimeOptions } from "../ui/runtime.js";
import { type MenuItem, select } from "../ui/select.js";
import { UI_COPY } from "../ui/ui-copy.js";

export const MAX_AUTH_JSON_BYTES = 4 * 1024 * 1024;

export type AuthJsonInputSource = "path" | "raw" | "cancel";

export class AuthJsonInputCancelledError extends Error {
	constructor() {
		super("auth.json import cancelled");
		this.name = "AuthJsonInputCancelledError";
	}
}

type JsonObjectCompletion =
	| { kind: "incomplete" }
	| { kind: "complete"; endIndex: number }
	| { kind: "invalid" };

/**
 * Locate the closing byte of one top-level JSON object without interpreting
 * its values. The real JSON parser still owns syntax validation; this scanner
 * only lets hidden multiline TTY paste finish automatically at the root `}`.
 */
export function inspectJsonObjectCompletion(raw: string): JsonObjectCompletion {
	let started = false;
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let index = 0; index < raw.length; index += 1) {
		const character = raw[index];
		if (!started) {
			if (/\s/.test(character ?? "") || character === "\uFEFF") continue;
			if (character !== "{") return { kind: "invalid" };
			started = true;
			depth = 1;
			continue;
		}

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (character === "\\") {
				escaped = true;
				continue;
			}
			if (character === '"') inString = false;
			continue;
		}

		if (character === '"') {
			inString = true;
			continue;
		}
		if (character === "{") {
			depth += 1;
			continue;
		}
		if (character === "}") {
			depth -= 1;
			if (depth < 0) return { kind: "invalid" };
			if (depth === 0) {
				return { kind: "complete", endIndex: index + 1 };
			}
		}
	}

	return { kind: "incomplete" };
}

export async function readAuthJsonFileContent(
	path: string,
	maxBytes = MAX_AUTH_JSON_BYTES,
): Promise<string> {
	const handle = await fs.open(path, "r");
	try {
		const stats = await handle.stat();
		if (!stats.isFile()) {
			throw new Error(`auth.json path is not a regular file: ${path}`);
		}
		if (stats.size > maxBytes) {
			throw new Error(`auth.json exceeds the ${maxBytes}-byte size limit`);
		}
		const content = await handle.readFile({ encoding: "utf-8" });
		if (Buffer.byteLength(content, "utf-8") > maxBytes) {
			throw new Error(`auth.json exceeds the ${maxBytes}-byte size limit`);
		}
		return content;
	} finally {
		await handle.close().catch(() => {
			// Best effort only; the read result/error remains authoritative.
		});
	}
}

async function readStreamToEnd(
	stream: NodeJS.ReadableStream & AsyncIterable<Buffer | string>,
	maxBytes: number,
): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of stream) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		size += buffer.length;
		if (size > maxBytes) {
			throw new Error(`auth.json exceeds the ${maxBytes}-byte size limit`);
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf-8");
}

function readHiddenJsonObjectFromTty(
	stream: NodeJS.ReadStream,
	maxBytes: number,
): Promise<string> {
	if (typeof stream.setRawMode !== "function") {
		throw new Error(
			"Secure hidden paste is unavailable in this terminal; pipe auth.json into --raw-auth-json instead",
		);
	}

	console.log(UI_COPY.authJsonImport.pastePrompt);
	output.write("◆  ");

	return new Promise<string>((resolve, reject) => {
		const wasRaw = stream.isRaw === true;
		const wasPaused = stream.isPaused();
		const decoder = new StringDecoder("utf8");
		let raw = "";
		let settled = false;

		const cleanup = () => {
			stream.removeListener("data", onData);
			try {
				stream.setRawMode?.(wasRaw);
			} catch {
				// Best effort restoration if the terminal closed during paste.
			}
			if (wasPaused) stream.pause();
			output.write("\n");
		};
		const finish = (value: string) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(value);
		};
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const assess = () => {
			if (Buffer.byteLength(raw, "utf-8") > maxBytes) {
				fail(new Error(`auth.json exceeds the ${maxBytes}-byte size limit`));
				return;
			}
			const completion = inspectJsonObjectCompletion(raw);
			if (completion.kind === "invalid") {
				fail(new Error("Pasted input must be one JSON object"));
				return;
			}
			if (completion.kind === "complete") {
				const trailing = raw.slice(completion.endIndex);
				if (trailing.trim().length > 0) {
					fail(new Error("Pasted input contains data after the JSON object"));
					return;
				}
				finish(raw.slice(0, completion.endIndex));
			}
		};
		const onData = (chunk: Buffer | string) => {
			const decoded =
				typeof chunk === "string" ? chunk : decoder.write(chunk);
			for (const character of decoded) {
				if (character === "\u0003") {
					fail(new AuthJsonInputCancelledError());
					return;
				}
				if (character === "\u0004") {
					finish(raw + decoder.end());
					return;
				}
				if (character === "\u007f" || character === "\b") {
					raw = raw.slice(0, -1);
					continue;
				}
				raw += character;
			}
			assess();
		};

		stream.setRawMode(true);
		stream.resume();
		stream.on("data", onData);
	});
}

export async function readRawAuthJsonInput(
	maxBytes = MAX_AUTH_JSON_BYTES,
): Promise<string> {
	if (input.isTTY) {
		return readHiddenJsonObjectFromTty(input, maxBytes);
	}
	return readStreamToEnd(input, maxBytes);
}

export async function promptAuthJsonInputSource(): Promise<AuthJsonInputSource> {
	const ui = getUiRuntimeOptions();
	const items: MenuItem<AuthJsonInputSource>[] = [
		{ label: UI_COPY.authJsonImport.path, value: "path", color: "green" },
		{ label: UI_COPY.authJsonImport.raw, value: "raw", color: "yellow" },
		{ label: UI_COPY.authJsonImport.back, value: "cancel", color: "red" },
	];
	const selected = await select<AuthJsonInputSource>(items, {
		message: UI_COPY.authJsonImport.title,
		subtitle: UI_COPY.authJsonImport.subtitle,
		help: UI_COPY.authJsonImport.help,
		clearScreen: true,
		theme: ui.theme,
		selectedEmphasis: "minimal",
		allowEscape: false,
		onInput: (raw) => {
			const normalized = raw.toLowerCase();
			if (normalized === "1") return "path";
			if (normalized === "2") return "raw";
			if (normalized === "q") return "cancel";
			return undefined;
		},
	});
	return selected ?? "cancel";
}

export async function promptAuthJsonPath(
	defaultPath: string,
): Promise<string | null> {
	const prompt = createInterface({ input, output });
	try {
		const answer = await prompt.question(
			UI_COPY.authJsonImport.pathPrompt(defaultPath),
		);
		return answer.trim() || defaultPath;
	} catch (error) {
		if (
			error instanceof Error &&
			(error.name === "AbortError" || /readline was closed/i.test(error.message))
		) {
			return null;
		}
		throw error;
	} finally {
		prompt.close();
	}
}
