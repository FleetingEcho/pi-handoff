/**
 * Injector — inserts the current handoff.md into the LLM context on every
 * request, via pi's `context` event.
 *
 * The event receives a deep copy of the message array: modifications are
 * safe, apply to the current call only, and are never persisted into the
 * session file. The injected content is therefore always as fresh as the
 * file on disk.
 */

import { readFileSync, statSync } from "node:fs";
import { HANDOFF_CAP_CHARS, HandoffStore } from "./store";

interface CacheEntry {
	mtimeMs: number;
	text: string;
}

export class Injector {
	private cache = new Map<string, CacheEntry>();

	constructor(private store: HandoffStore) {}

	private readFresh(path: string): string {
		try {
			const st = statSync(path);
			const hit = this.cache.get(path);
			if (hit && hit.mtimeMs === st.mtimeMs) return hit.text;
			const text = readFileSync(path, "utf8");
			this.cache.set(path, { mtimeMs: st.mtimeMs, text });
			return text;
		} catch {
			return "";
		}
	}

	/** Build the synthetic context message, or return null when there is nothing worth injecting. */
	buildMessage(): { role: "custom"; customType: string; content: string; display: boolean; timestamp: number } | null {
		const handoff = this.readFresh(this.store.handoffPath);
		// Pins are project-scoped (shared across branches), so they are worth
		// injecting even on a brand-new branch whose handoff is still empty.
		const pins = this.store.pinnedNotes();
		if (!HandoffStore.hasRealContent(handoff) && pins.length === 0) return null;

		const body =
			handoff.length <= HANDOFF_CAP_CHARS
				? handoff.trim()
				: handoff.slice(0, HANDOFF_CAP_CHARS) + `\n\n[...truncated by pi-handoff — full content in ${this.store.handoffPath}]`;

		const pinned = pins.length ? `\n\n# Pinned\n\n${pins.join("\n")}` : "";

		const content = `The handoff document for this working directory follows. It is maintained automatically by the user's pi-handoff extension and updated with fresh state as work proceeds. Treat it as authoritative context about prior work, decisions, and the current task; continue from it without re-deriving it. File: ${this.store.handoffPath} (outside the project). The "# Pinned" section holds standing rules for this project that apply on every branch — follow them.

<project-handoff>

${body}${pinned}

</project-handoff>`;

		return {
			role: "custom",
			customType: "pi-handoff",
			content,
			display: false,
			timestamp: Date.now(),
		};
	}
}
