/**
 * Collector — turns pi agent events into redacted, bounded turn_end records.
 *
 * Performs NO semantic judgment: decisions/progress extraction is the
 * refresher's job. Everything the collector does is deterministic.
 */

import type { TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { redact } from "./redact";
import type { HandoffEvent, HandoffStore } from "./store";

const USER_EXCERPT_MAX = 2_000;
const ASSISTANT_EXCERPT_MAX = 2_000;
const TOOL_EXCERPT_MAX = 500;
const TOOL_ARGS_DIGEST_MAX = 160;

type Excerpt = NonNullable<HandoffEvent["excerpts"]>[number];

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return text.slice(0, max) + `… [+${text.length - max} chars]`;
}

/** Flatten message content blocks to text parts, skipping images/thinking. */
function textParts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	const out: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object" && (part as any).type === "text" && typeof (part as any).text === "string") {
			out.push((part as any).text);
		}
	}
	return out;
}

/** One-line digest for an assistant toolCall content block. */
function toolCallDigests(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const out: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as any;
		if (block.type !== "toolCall" || typeof block.name !== "string") continue;
		let args = "";
		try {
			args = truncate(redact(JSON.stringify(block.arguments ?? {})), TOOL_ARGS_DIGEST_MAX);
		} catch {
			args = "(unserializable args)";
		}
		out.push(`→ ${block.name} ${args}`);
	}
	return out;
}

export class Collector {
	private pendingUser: string[] = [];
	private toolStartPaths = new Map<string, string>();
	private turnChangedFiles = new Set<string>();

	constructor(private store: HandoffStore) {}

	/** message_end: buffer the latest user prompt(s) for the next turn_end. */
	onMessageEnd(message: { role?: string; content?: unknown }): void {
		if (message.role !== "user") return;
		const text = redact(textParts(message.content).join("\n").trim());
		if (text) this.pendingUser.push(truncate(text, USER_EXCERPT_MAX));
	}

	/** tool_execution_start: remember write/edit targets so we can report changed files. */
	onToolStart(toolCallId: string, toolName: string, args: any): void {
		if (toolName !== "write" && toolName !== "edit") return;
		const path = typeof args?.path === "string" ? args.path : undefined;
		if (path) this.toolStartPaths.set(toolCallId, path);
	}

	onToolEnd(toolCallId: string, toolName: string, isError: boolean): void {
		const path = this.toolStartPaths.get(toolCallId);
		if (path && (toolName === "write" || toolName === "edit") && !isError) {
			this.turnChangedFiles.add(path);
		}
		this.toolStartPaths.delete(toolCallId);
	}

	/** turn_end: assemble + append one redacted event. */
	onTurnEnd(event: TurnEndEvent): HandoffEvent {
		const excerpts: Excerpt[] = [];

		for (const userText of this.pendingUser.splice(0)) {
			excerpts.push({ role: "user", text: userText });
		}

		const msg = event.message as any;
		if (msg?.role === "assistant") {
			for (const t of textParts(msg.content)) {
				const red = redact(t.trim());
				if (red) excerpts.push({ role: "assistant", text: truncate(red, ASSISTANT_EXCERPT_MAX) });
			}
			for (const line of toolCallDigests(msg.content)) {
				excerpts.push({ role: "assistant", text: line });
			}
		}

		for (const tr of event.toolResults ?? []) {
			const name = (tr as any).toolName ?? "tool";
			const flat = textParts((tr as any).content).join("\n").trim();
			const red = truncate(redact(flat || "(no text output)"), TOOL_EXCERPT_MAX);
			excerpts.push({
				role: "tool",
				toolName: name,
				text: (tr as any).isError ? `[error] ${red}` : red,
			});
		}

		const changedFiles = [...this.turnChangedFiles];
		this.turnChangedFiles.clear();

		return this.store.appendEvent({
			sessionId: this.store.meta.sessionId,
			turn: event.turnIndex,
			type: "turn_end",
			excerpts,
			changedFiles,
		});
	}
}
