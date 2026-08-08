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
import { HANDOFF_CAP_CHARS, PROJECT_KNOWLEDGE_CAP_CHARS, HandoffStore } from "./store";

interface CacheEntry {
	mtimeMs: number;
	size: number;
	ino: number;
	text: string;
}

export class Injector {
	private cache = new Map<string, CacheEntry>();

	constructor(private store: HandoffStore) {}

	private readFresh(path: string): string {
		try {
			const st = statSync(path);
			const hit = this.cache.get(path);
			if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && hit.ino === st.ino) return hit.text;
			const text = readFileSync(path, "utf8");
			this.cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, text });
			return text;
		} catch {
			return "";
		}
	}

	/** Build the synthetic context message, or return null when there is nothing worth injecting. */
	buildMessage(): { role: "custom"; customType: string; content: string; display: boolean; timestamp: number } | null {
		const handoff = this.readFresh(this.store.handoffPath);
		const projectKnowledge = this.store.readProjectKnowledge();
		const pins = this.store.pinnedNotes();
		if (!HandoffStore.hasRealContent(handoff) && !HandoffStore.hasRealContent(projectKnowledge) && pins.length === 0) return null;

		const body =
			handoff.length <= HANDOFF_CAP_CHARS
				? handoff.trim()
				: handoff.slice(0, HANDOFF_CAP_CHARS) + `\n\n[...truncated by pi-handoff — full content in ${this.store.handoffPath}]`;

		const projectForContext = projectKnowledge.length <= PROJECT_KNOWLEDGE_CAP_CHARS
			? projectKnowledge
			: projectKnowledge.slice(0, PROJECT_KNOWLEDGE_CAP_CHARS) + `\n\n[...project knowledge truncated; full content in ${this.store.projectDocPath}]`;
		const project = HandoffStore.hasRealContent(projectKnowledge)
			? `\n\n<project-knowledge file="${this.store.projectDocPath}">\n${projectForContext}\n</project-knowledge>`
			: "";
		const pinned = pins.length ? `\n\n<pinned-rules>\n${pins.join("\n")}\n</pinned-rules>` : "";

		const content = `The branch handoff and shared project knowledge follow. The branch handoff describes current task state. Project knowledge describes durable architecture, conventions, workflows, decisions, and pitfalls shared by every branch. Pinned rules are user-managed hard constraints. Use all three as authoritative prior context; do not confuse project-wide knowledge with current branch progress.

<branch-handoff file="${this.store.handoffPath}">

${body}

</branch-handoff>${project}${pinned}`;

		return {
			role: "custom",
			customType: "pi-handoff",
			content,
			display: false,
			timestamp: Date.now(),
		};
	}
}
