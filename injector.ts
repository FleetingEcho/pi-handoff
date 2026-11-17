/**
 * Injector — inserts the handoff.md into the LLM context on every request, via
 * pi's `context` event.
 *
 * The event receives a deep copy of the message array: modifications are
 * safe, apply to the current call only, and are never persisted into the
 * session file.
 *
 * The injected text is a per-session snapshot rather than a fresh read — see
 * `frozen` below for why that is a large token saving and costs nothing.
 */

import { readFileSync, statSync } from "node:fs";
import { HANDOFF_CAP_CHARS, PROJECT_KNOWLEDGE_CAP_CHARS, HandoffStore } from "./store";

interface CacheEntry {
	mtimeMs: number;
	size: number;
	ino: number;
	text: string;
}

type InjectedMessage = { role: "custom"; customType: string; content: string; display: boolean; timestamp: number };

export class Injector {
	private cache = new Map<string, CacheEntry>();

	/**
	 * Session-stable snapshot of the injected text.
	 *
	 * This block sits at the FRONT of the provider's cached prefix. Rebuilding it
	 * per request means every background fold rewrites that prefix, invalidating
	 * the prompt cache for the WHOLE conversation — re-paying full input price
	 * for every earlier message, which costs far more than the fold that caused
	 * it. Between folds the text is identical anyway, so the rebuild bought
	 * nothing and the cache miss was pure loss.
	 *
	 * So it is built once and frozen for the session. Nothing is lost by going
	 * stale: the model lived through the turns a fold summarises, so re-injecting
	 * them tells it what it already knows. `invalidate()` is called only where
	 * the frozen text genuinely stops matching the conversation — after a
	 * compaction (that history has left the window) and after a clear (the
	 * document it described is gone). A branch switch builds a new Injector.
	 *
	 * Freezing the whole object also pins `timestamp`, so a serialized timestamp
	 * cannot bust the cache on every single request.
	 */
	private frozen: InjectedMessage | null = null;

	/** Drop the snapshot so the next request rebuilds it from disk. */
	invalidate(): void {
		this.frozen = null;
	}

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
	buildMessage(): InjectedMessage | null {
		if (this.frozen) return this.frozen;
		const handoff = this.readFresh(this.store.handoffPath);
		const { knowledge: projectKnowledge, pins } = this.store.parseProjectDoc(this.readFresh(this.store.projectDocPath));
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

		// Only a non-null build is frozen: a session that starts with an empty
		// handoff must keep looking until there is something to inject.
		this.frozen = {
			role: "custom",
			customType: "pi-handoff",
			content,
			display: false,
			timestamp: Date.now(),
		};
		return this.frozen;
	}
}
