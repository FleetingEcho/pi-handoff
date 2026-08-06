/**
 * HandoffStore — on-disk persistence for pi-handoff.
 *
 * Nothing is written into the project. Every working directory gets its own
 * directory, named after its absolute path, holding exactly three files:
 *
 *   ~/.pi/agent/pi-handoff/-home-zteng-work-Tools-TanWords/
 *   ├── handoff.md     the handoff document (the point of all this)
 *   ├── events.jsonl   append-only log of what happened (trimmed in place)
 *   └── meta.json      cursors, telemetry, which project this belongs to
 *
 * No subdirectories, ever. Previous versions of handoff.md are kept as
 * `snapshot` records inside events.jsonl rather than as separate files.
 *
 * Writes are atomic: temp file -> rename.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, appendFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export const HANDOFF_SECTIONS = [
	"Current Goal",
	"Progress",
	"Decisions",
	"Constraints",
	"Open Questions",
	"Active Files",
	"Next Steps",
] as const;

/** Rough char budget (~6000 tokens @ ~4 chars/token). */
export const HANDOFF_CAP_CHARS = 24_000;
/** Cap on the serialized new-events payload fed to one refresh call. */
export const NEW_EVENTS_CAP_CHARS = 30_000;

/** Event-log trimming: oldest already-folded-in records are dropped in place. */
const EVENTS_MAX_BYTES = 4 * 1024 * 1024;
/** Trim down to this, not to the limit, so trimming is rare rather than constant. */
const EVENTS_TARGET_BYTES = 2 * 1024 * 1024;
const TRIM_CHECK_EVERY = 20;

/**
 * On graceful shutdown, clear events.jsonl entirely once it holds at least
 * this many records — a clean slate for the next session. Below the threshold
 * the log is left intact so recent snapshot history survives across restarts
 * (the basis for recovering a prior handoff). At/above the threshold we wipe
 * it, which also discards older snapshots (an accepted tradeoff for disk
 * hygiene). 0 disables. Override via PI_HANDOFF_EXIT_CLEAR_LINES.
 */
const EVENTS_EXIT_CLEAR_LINES = (() => {
	const raw = process.env.PI_HANDOFF_EXIT_CLEAR_LINES;
	const parsed = raw !== undefined && raw.trim() !== "" ? Number.parseInt(raw, 10) : NaN;
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500; // explicit 0 disables; unset/garbage → default
})();

const DEFAULT_PINNED =
	"# Pinned\n\n- (pinned notes are written by `/pi-handoff pin` and are never modified or removed by the summarizer)\n";

const HANDOFF_SKELETON = `${HANDOFF_SECTIONS.map((s) => `# ${s}\n`).join("\n")}\n${DEFAULT_PINNED}`;

/** Root of all per-project stores: $PI_HANDOFF_DIR, else ~/.pi/agent/pi-handoff. */
export function storeHome(): string {
	const override = process.env.PI_HANDOFF_DIR?.trim();
	if (override) {
		const expanded = override.startsWith("~") ? join(homedir(), override.slice(1)) : override;
		return isAbsolute(expanded) ? expanded : resolve(expanded);
	}
	// alongside pi's own state (sessions/, extensions/, git/), not at the config root
	return join(homedir(), CONFIG_DIR_NAME, "agent", "pi-handoff");
}

/** Longest directory name most filesystems accept, minus room for a suffix. */
const SLUG_MAX = 200;

/**
 * Directory name for a project: its absolute path with every non-portable
 * character folded to `-`, e.g. `/home/zteng/work/Tools/TanWords` becomes
 * `-home-zteng-work-Tools-TanWords`. The full path is the key, so two projects
 * can never collide. Overlong paths keep their tail plus a hash of the whole.
 */
export function pathSlug(abs: string): string {
	const flat = abs.replace(/[^A-Za-z0-9._-]+/g, "-") || "-";
	if (flat.length <= SLUG_MAX) return flat;
	const hash = createHash("sha256").update(abs).digest("hex").slice(0, 8);
	return `${flat.slice(flat.length - SLUG_MAX)}-${hash}`;
}

/** Per-project store directory, derived from the working directory's absolute path. */
export function resolveStoreRoot(cwd: string): { root: string; projectPath: string; slug: string } {
	let abs = resolve(cwd);
	try {
		abs = realpathSync(abs); // symlinked checkouts must map to one store
	} catch {
		// path may not exist yet — key off what we were given
	}
	const slug = pathSlug(abs);
	return { root: join(storeHome(), slug), projectPath: abs, slug };
}

export interface HandoffEvent {
	schemaVersion: number;
	seq: number;
	sessionId: string;
	turn: number;
	timestamp: string;
	type: "turn_end" | "pin" | "reset" | "compact" | "snapshot";
	excerpts?: Array<{ role: "user" | "assistant" | "tool"; text: string; toolName?: string; targetPath?: string }>;
	changedFiles?: string[];
	note?: string;
	/** For `snapshot`: the full handoff.md text as it was before being overwritten. */
	doc?: string;
}

export interface Meta {
	schemaVersion: number;
	/** Working directory this store belongs to (replaces the old project.json). */
	projectPath: string;
	createdAt: string;
	sessionId: string;
	/** OS pid of the session that last took ownership of this store. Used to tell a
	 * genuinely concurrent writer (pid still alive) from a sequential restart. */
	pid: number;
	/** ISO timestamp set when the owner ended gracefully (quit, /new, /resume, /fork,
	 * /reload). Empty while a session is live. Lets the next session_start tell a
	 * sequential handoff from a concurrent one without a false-positive warning. */
	endedAt: string;
	nextSeq: number;
	lastCollectedSeq: number;
	lastRefreshedSeq: number;
	summarizerUsage: { calls: number; totalTokens: number };
	enabled: boolean;
	updatedAt: string;
}

function defaultMeta(): Meta {
	const now = new Date().toISOString();
	return {
		schemaVersion: 3,
		projectPath: "",
		createdAt: now,
		sessionId: "",
		pid: 0,
		endedAt: "",
		nextSeq: 1,
		lastCollectedSeq: 0,
		lastRefreshedSeq: 0,
		summarizerUsage: { calls: 0, totalTokens: 0 },
		enabled: true,
		updatedAt: now,
	};
}

export class HandoffStore {
	readonly root: string;
	readonly handoffPath: string;
	readonly eventsPath: string;
	readonly metaPath: string;
	/** Working directory this store belongs to ("" when unknown). */
	readonly projectPath: string;

	meta: Meta = defaultMeta();
	/** chars of turn_end excerpts collected since lastRefreshedSeq (maintained on append, recomputed on load) */
	pendingChars = 0;

	constructor(root: string, projectPath = "") {
		this.root = root;
		this.projectPath = projectPath;
		this.handoffPath = join(root, "handoff.md");
		this.eventsPath = join(root, "events.jsonl");
		this.metaPath = join(root, "meta.json");
	}

	/** Store for the given working directory, under ~/.pi/agent/pi-handoff/<slug>/. */
	static forCwd(cwd: string): HandoffStore {
		const { root, projectPath } = resolveStoreRoot(cwd);
		return new HandoffStore(root, projectPath);
	}

	get exists(): boolean {
		return existsSync(this.root);
	}

	initSync(): void {
		mkdirSync(this.root, { recursive: true });
		// Migrate legacy uppercase filename → lowercase. On a case-sensitive FS
		// (Linux) the two are distinct files, so rename the old one over. On a
		// case-insensitive FS (macOS/Windows) both names resolve to the same file
		// already, so existsSync(handoff.md) is true and we skip — a no-op there.
		const legacy = join(this.root, "HANDOFF.md");
		if (!existsSync(this.handoffPath) && existsSync(legacy)) {
			try { renameSync(legacy, this.handoffPath); } catch { /* best-effort */ }
		}
		if (!existsSync(this.eventsPath)) writeFileSync(this.eventsPath, "");
		if (!existsSync(this.handoffPath)) this.atomicWriteSync(this.handoffPath, HANDOFF_SKELETON);
		this.meta = this.loadMeta();
		if (!this.meta.projectPath && this.projectPath) {
			this.meta.projectPath = this.projectPath;
			this.saveMetaSync();
		}
	}

	loadMeta(): Meta {
		try {
			const raw = readFileSync(this.metaPath, "utf8");
			return { ...defaultMeta(), ...(JSON.parse(raw) as Partial<Meta>) };
		} catch {
			return defaultMeta();
		}
	}

	saveMetaSync(): void {
		this.meta.updatedAt = new Date().toISOString();
		this.atomicWriteSync(this.metaPath, JSON.stringify(this.meta, null, 2));
	}

	readHandoff(): string {
		return this.readSafe(this.handoffPath);
	}

	private readSafe(path: string): string {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return "";
		}
	}

	// ---------------------------------------------------------------- events

	appendEvent(ev: Omit<HandoffEvent, "seq" | "schemaVersion" | "timestamp">): HandoffEvent {
		const full: HandoffEvent = {
			schemaVersion: 2,
			seq: this.meta.nextSeq++,
			timestamp: new Date().toISOString(),
			...ev,
		};
		appendFileSync(this.eventsPath, JSON.stringify(full) + "\n");
		if (full.type === "turn_end") {
			this.meta.lastCollectedSeq = full.seq;
			this.pendingChars += (full.excerpts ?? []).reduce((n, e) => n + e.text.length, 0);
		}
		this.saveMetaSync();
		this.maybeTrimEvents();
		return full;
	}

	/** All events with seq > afterSeq, tolerating a malformed tail line (crash during append). */
	readEventsSince(afterSeq: number): HandoffEvent[] {
		const out: HandoffEvent[] = [];
		for (const line of this.readSafe(this.eventsPath).split("\n")) {
			if (!line.trim()) continue;
			try {
				const ev = JSON.parse(line) as HandoffEvent;
				if (typeof ev.seq === "number" && ev.seq > afterSeq) out.push(ev);
			} catch {
				// malformed line (interrupted write) — ignore and continue
			}
		}
		return out;
	}

	/** Previous versions of handoff.md, newest first — the replacement for history/. */
	readSnapshots(limit = 10): Array<{ seq: number; timestamp: string; doc: string }> {
		const out: Array<{ seq: number; timestamp: string; doc: string }> = [];
		for (const line of this.readSafe(this.eventsPath).split("\n")) {
			if (!line.includes('"snapshot"')) continue; // cheap pre-filter
			try {
				const ev = JSON.parse(line) as HandoffEvent;
				if (ev.type === "snapshot" && ev.doc) out.push({ seq: ev.seq, timestamp: ev.timestamp, doc: ev.doc });
			} catch {
				// ignore
			}
		}
		return out.reverse().slice(0, limit);
	}

	markRefreshed(throughSeq: number): void {
		this.meta.lastRefreshedSeq = throughSeq;
		this.pendingChars = 0;
		this.saveMetaSync();
	}

	recordUsage(usage?: { input?: number; output?: number; totalTokens?: number }): void {
		if (!usage) return;
		this.meta.summarizerUsage.calls++;
		this.meta.summarizerUsage.totalTokens += usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0);
	}

	/**
	 * Keep the log bounded by dropping its oldest lines in place — no archive
	 * files. Only records already folded into handoff.md are eligible, so a
	 * pending refresh never loses its input.
	 */
	private maybeTrimEvents(): void {
		if (this.meta.nextSeq % TRIM_CHECK_EVERY !== 0) return;
		try {
			if (statSync(this.eventsPath).size <= EVENTS_MAX_BYTES) return;
			const lines = this.readSafe(this.eventsPath).split("\n").filter((l) => l.trim());
			// walk back from the newest line, keeping lines until the byte target is met
			let cut = lines.length;
			let kept = 0;
			while (cut > 0 && kept + lines[cut - 1].length + 1 <= EVENTS_TARGET_BYTES) {
				kept += lines[cut - 1].length + 1;
				cut--;
			}
			while (cut > 0) {
				// never drop a record a future refresh still needs
				const seq = seqOf(lines[cut - 1]);
				if (seq !== null && seq <= this.meta.lastRefreshedSeq) break;
				cut--;
			}
			if (cut === 0) return;
			this.atomicWriteSync(this.eventsPath, lines.slice(cut).join("\n") + "\n");
		} catch {
			// trimming is best-effort — never fatal
		}
	}

	/**
	 * On graceful shutdown, drop the whole event log if it has grown to at least
	 * EVENTS_EXIT_CLEAR_LINES records, for a clean slate next session. Returns
	 * true if it cleared. Best-effort: a failure never fatalizes shutdown. Below
	 * the threshold the log is kept so short sessions retain snapshot history.
	 */
	clearEventsOnShutdownIfLarge(): boolean {
		if (EVENTS_EXIT_CLEAR_LINES <= 0) return false;
		try {
			const lines = this.readSafe(this.eventsPath).split("\n").filter((l) => l.trim());
			if (lines.length < EVENTS_EXIT_CLEAR_LINES) return false;
			this.atomicWriteSync(this.eventsPath, "");
			return true;
		} catch {
			return false;
		}
	}

	// ------------------------------------------------------- curated document

	/** Split the doc into the LLM-managed body and the program-managed Pinned section. */
	splitPinned(doc: string): { body: string; pinned: string | null } {
		const idx = doc.search(/^# Pinned\s*$/m);
		if (idx < 0) return { body: doc, pinned: null };
		return { body: doc.slice(0, idx).trimEnd(), pinned: doc.slice(idx).trimEnd() + "\n" };
	}

	/** Assemble the final doc: LLM output + re-attached Pinned. */
	composeHandoff(llmBody: string): string {
		const { pinned } = this.splitPinned(this.readHandoff());
		return `${llmBody.trimEnd()}\n\n---\n\n${pinned ?? DEFAULT_PINNED}`;
	}

	appendPinned(note: string): void {
		const { body, pinned } = this.splitPinned(this.readHandoff());
		const next = `${(pinned ?? DEFAULT_PINNED).trimEnd()}\n- ${note.replace(/\n+/g, " ").trim()}\n`;
		this.atomicWriteSync(this.handoffPath, `${body.trimEnd()}\n\n---\n\n${next}`);
	}

	/** Write a refreshed handoff (snapshotting the old one into the log). llmBody must already be validated. */
	writeHandoff(llmBody: string, opts: { snapshot: boolean }): void {
		if (opts.snapshot) this.snapshot();
		this.atomicWriteSync(this.handoffPath, this.composeHandoff(llmBody));
	}

	/** Start a fresh handoff for a new task, keeping the Pinned section. */
	resetKeepingPinned(): void {
		const { pinned } = this.splitPinned(this.readHandoff());
		this.snapshot();
		this.atomicWriteSync(this.handoffPath, HANDOFF_SKELETON.replace(DEFAULT_PINNED, (pinned ?? DEFAULT_PINNED).trimEnd() + "\n"));
	}

	/** Record the current document into the event log before it is overwritten. */
	private snapshot(): void {
		try {
			const doc = this.readHandoff();
			if (!HandoffStore.hasRealContent(doc)) return; // nothing worth keeping
			this.appendEvent({ sessionId: this.meta.sessionId, turn: -1, type: "snapshot", doc });
		} catch {
			// snapshot failure must not block a write
		}
	}

	// ---------------------------------------------------------------- helpers

	private atomicWriteSync(path: string, content: string): void {
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, content);
		renameSync(tmp, path);
	}

	/** Doc has meaningful content beyond section headings / placeholder pins. */
	static hasRealContent(doc: string): boolean {
		const body = doc
			.split("\n")
			.filter((l) => !l.startsWith("#") && l.trim() !== "---" && !l.startsWith("- (pinned notes"))
			.join("")
			.trim();
		return body.length >= 24;
	}
}

function seqOf(line: string): number | null {
	try {
		const seq = (JSON.parse(line) as HandoffEvent).seq;
		return typeof seq === "number" ? seq : null;
	} catch {
		return null;
	}
}

export { HANDOFF_SKELETON };
