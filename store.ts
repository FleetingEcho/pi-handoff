/**
 * HandoffStore — on-disk persistence for pi-handoff.
 *
 * Nothing is written into the project. Every project gets its own directory
 * under the store root, named after the project root's absolute path (see
 * resolveProjectRoot in index.ts — the git repo/worktree top-level when the
 * working directory is inside a repo, so opening the agent from a
 * subdirectory of the same repo lands on the SAME store; outside git the
 * working directory itself is the key):
 *
 *   ~/.agent/agent-handoff/-home-zteng-work-Tools-TanWords/
 *   ├── project.md         standing pinned rules, shared by EVERY branch
 *   └── <branch-slug>/
 *       ├── handoff.md     the handoff document (the point of all this)
 *       ├── events.jsonl   append-only log of what happened (trimmed in place)
 *       └── meta.json      cursors, telemetry, which project/branch this belongs to
 *
 * Two tiers, because the content has two different lifetimes. Task state (goal,
 * progress, next steps) is per-branch: switching branches switches handoffs, and
 * a non-git directory uses "default". Pinned rules ("deploys go through
 * ops/deploy.sh") are per-PROJECT — true regardless of branch, so they live one
 * level up and a brand-new branch inherits them instead of starting blank.
 * migratePinnedToProject lifts legacy branch-local pins on first load. This
 * layout is shared with opencode-handoff (same store root), so the two agents
 * see the same pins.
 * Previous versions of handoff.md are kept as `snapshot` records inside
 * events.jsonl rather than as separate files.
 *
 * Writes are atomic: temp file -> rename.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
 * the log is left intact so recent snapshot history survives across restarts.
 *
 * DEFAULTS TO OFF (0) for pi-handoff: the store is shared with opencode-handoff
 * (and any other agent) at ~/.agent/agent-handoff, so wiping the log on one
 * agent's exit would discard events another concurrent agent still needs.
 * Set PI_HANDOFF_EXIT_CLEAR_LINES to a positive number (e.g. 500) to
 * enable the disk-hygiene wipe when you only ever run one agent at a time.
 */
const EVENTS_EXIT_CLEAR_LINES = (() => {
	const raw = process.env.PI_HANDOFF_EXIT_CLEAR_LINES;
	const parsed = raw !== undefined && raw.trim() !== "" ? Number.parseInt(raw, 10) : NaN;
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0; // default 0 (off) for the shared store
})();

const DEFAULT_PINNED =
	"# Pinned\n\n- (pinned notes are written by `/pi-handoff pin` and are never modified or removed by the summarizer)\n";

const HANDOFF_SKELETON = `${HANDOFF_SECTIONS.map((s) => `# ${s}\n`).join("\n")}`;

/**
 * Root of all per-project stores: $PI_HANDOFF_DIR, else ~/.agent/agent-handoff.
 * Lives under a shared, tool-neutral ~/.agent root (not pi's own config dir) so
 * other agents can read the handoff documents too.
 */
export function storeHome(): string {
	const override = process.env.PI_HANDOFF_DIR?.trim();
	if (override) {
		const expanded = override.startsWith("~") ? join(homedir(), override.slice(1)) : override;
		return isAbsolute(expanded) ? expanded : resolve(expanded);
	}
	return join(homedir(), ".agent", "agent-handoff");
}

/**
 * Pre-v0.3.6 store root: ~/.pi/agent/pi-handoff. Used only by the one-time
 * migration in initSync() to carry existing stores forward to storeHome().
 */
function legacyStoreHome(): string {
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

/**
 * Directory name for a git branch: the branch name with every non-portable
 * character folded to `-` (so `feature/auth` → `feature-auth`). Branches whose
 * names collide after sanitizing (e.g. `feature/x` and `feature-x`, both →
 * `feature-x`) are disambiguated by resolveStoreRoot via a short hash.
 * "default" for the empty/non-git case.
 */
export function branchSlug(branch: string): string {
	const flat = branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
	if (flat.length <= SLUG_MAX) return flat;
	const hash = createHash("sha256").update(branch).digest("hex").slice(0, 8);
	return `${flat.slice(flat.length - SLUG_MAX)}-${hash}`;
}

/** Read just the `branch` field from a store's meta.json, or null if absent/unreadable. */
function readMetaBranch(metaPath: string): string | null {
	try {
		const m = JSON.parse(readFileSync(metaPath, "utf8")) as Partial<Meta>;
		return typeof m.branch === "string" && m.branch ? m.branch : null;
	} catch {
		return null;
	}
}

/**
 * Per-project, per-branch store directory, derived from the project root's
 * absolute path and the current git branch. The project root becomes a
 * container directory; each branch gets a subdirectory inside it. If another
 * branch already occupies the sanitized slug, a short hash is appended so the
 * two can't clobber each other.
 */
export function resolveStoreRoot(cwd: string, branch: string): { root: string; projectPath: string; cwdSlug: string; branchSlug: string } {
	const { abs, cwdSlug, container } = projectKey(cwd);
	let bSlug = branchSlug(branch);
	const candidate = join(container, bSlug);
	if (existsSync(candidate)) {
		const existing = readMetaBranch(join(candidate, "meta.json"));
		if (existing && existing !== branch) {
			bSlug = `${bSlug}-${createHash("sha256").update(branch).digest("hex").slice(0, 8)}`;
		}
	}
	return { root: join(container, bSlug), projectPath: abs, cwdSlug, branchSlug: bSlug };
}

/**
 * One-time carry of a cwd-keyed container (pre-v0.9.0 layout, where the store
 * was named after the working directory itself) to the repo-root key. Fires
 * only when the repo-root container doesn't exist yet and the legacy cwd-keyed
 * one does — it can never clobber, and it never merges: a project historically
 * opened from several different subdirectories keeps its FIRST-seen legacy
 * store, and any others stay on disk, orphaned but intact.
 */
export function migrateProjectKey(cwd: string, projectRoot: string): boolean {
	if (cwd === projectRoot) return false;
	const from = projectKey(cwd).container;
	const to = projectKey(projectRoot).container;
	if (from === to) return false;
	try {
		if (!existsSync(from) || existsSync(to)) return false;
		renameSync(from, to);
		return true;
	} catch {
		return false; // best-effort: nothing moved beats half-moved
	}
}

/** Absolute path + container dir + slug for a working directory. */
export function projectKey(cwd: string): { abs: string; cwdSlug: string; container: string } {
	let abs = resolve(cwd);
	try {
		abs = realpathSync(abs); // symlinked checkouts must map to one store
	} catch {
		// path may not exist yet — key off what we were given
	}
	const cwdSlug = pathSlug(abs);
	return { abs, cwdSlug, container: join(storeHome(), cwdSlug) };
}

export interface BranchDoc {
	/** True branch name from the store's meta.json (directory slug as fallback). */
	branch: string;
	path: string;
	doc: string;
}

/**
 * Read every branch handoff of the PROJECT that owns `cwd` — all branch
 * subdirectories under the project container, plus the pre-v0.4.0 flat
 * handoff.md if it still carries content. Docs without real content (fresh
 * skeletons) are skipped. Read-only; feeds `/pi-handoff distill`.
 */
export function listBranchDocs(cwd: string): BranchDoc[] {
	const { container } = projectKey(cwd);
	const out: BranchDoc[] = [];
	const readDoc = (p: string): string => {
		try {
			return readFileSync(p, "utf8");
		} catch {
			return "";
		}
	};
	try {
		for (const ent of readdirSync(container, { withFileTypes: true })) {
			if (!ent.isDirectory()) continue;
			const p = join(container, ent.name, "handoff.md");
			const doc = readDoc(p);
			if (!HandoffStore.hasRealContent(doc)) continue;
			out.push({ branch: readMetaBranch(join(container, ent.name, "meta.json")) ?? ent.name, path: p, doc });
		}
		const flat = join(container, "handoff.md");
		if (existsSync(flat) && statSync(flat).isFile()) {
			const doc = readDoc(flat);
			if (HandoffStore.hasRealContent(doc)) out.push({ branch: "(flat, pre-branch layout)", path: flat, doc });
		}
	} catch {
		// whatever was readable is enough for a best-effort distill
	}
	return out;
}

/** Read just the `branch` field from a store's meta.json, or null if absent/unreadable. */

export interface HandoffEvent {
	schemaVersion: number;
	seq: number;
	sessionId: string;
	turn: number;
	timestamp: string;
	type: "turn_end" | "pin" | "clear" | "compact" | "snapshot";
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
	/** Git branch this store is scoped to ("default" when not in a repo). */
	branch: string;
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
		branch: "",
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
	/** Project-level pinned doc, one level up from the branch dir and therefore
	 * shared by every branch of this project. */
	readonly projectDocPath: string;
	/** Working directory this store belongs to ("" when unknown). */
	readonly projectPath: string;
	/** Git branch this store is scoped to ("default" when not in a repo). */
	readonly branch: string;
	/** Slug of the working directory — the container under storeHome(). */
	readonly cwdSlug: string;

	meta: Meta = defaultMeta();
	/** chars of turn_end excerpts collected since lastRefreshedSeq (maintained on append, recomputed on load) */
	pendingChars = 0;
	/** # of turn_end events collected since lastRefreshedSeq — the turn-count backstop for auto-refresh (maintained on append, recomputed on load). */
	turnsSinceRefresh = 0;

	constructor(root: string, projectPath = "", branch = "", cwdSlug = "") {
		this.root = root;
		this.projectPath = projectPath;
		this.branch = branch;
		this.cwdSlug = cwdSlug;
		this.handoffPath = join(root, "handoff.md");
		this.eventsPath = join(root, "events.jsonl");
		this.metaPath = join(root, "meta.json");
		this.projectDocPath = join(dirname(root), "project.md");
	}

	/** Store for the given working directory + git branch, under ~/.agent/agent-handoff/<cwd-slug>/<branch-slug>/. */
	static forCwdAndBranch(cwd: string, branch: string): HandoffStore {
		const { root, projectPath, cwdSlug } = resolveStoreRoot(cwd, branch);
		return new HandoffStore(root, projectPath, branch, cwdSlug);
	}

	/** Store for the given working directory on the "default" (non-git) branch. */
	static forCwd(cwd: string): HandoffStore {
		return HandoffStore.forCwdAndBranch(cwd, "default");
	}

	get exists(): boolean {
		return existsSync(this.root);
	}

	initSync(): void {
		mkdirSync(this.root, { recursive: true });
		this.migrateFromLegacyRoot();
		this.migrateFlatToBranch();
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
		if (!existsSync(this.projectDocPath)) this.atomicWriteSync(this.projectDocPath, DEFAULT_PINNED);
		this.migratePinnedToProject();
		this.meta = this.loadMeta();
		let changed = false;
		if (!this.meta.projectPath && this.projectPath) {
			this.meta.projectPath = this.projectPath;
			changed = true;
		}
		if (!this.meta.branch && this.branch) {
			this.meta.branch = this.branch;
			changed = true;
		}
		if (changed) this.saveMetaSync();
	}

	/**
	 * One-time move from the pre-v0.3.6 root (~/.pi/agent/pi-handoff/<slug>/) to
	 * the current root (~/.agent/agent-handoff/<slug>/). Fires only when the new
	 * store has no handoff.md yet but the legacy location does, so it's safe to
	 * run every session and never clobbers a store already at the new path.
	 * Best-effort: a failure falls through to a fresh skeleton.
	 */
	private migrateFromLegacyRoot(): void {
		const legacyRoot = join(legacyStoreHome(), this.cwdSlug);
		if (legacyRoot === this.root) return;
		if (existsSync(this.handoffPath)) return; // new store already populated
		if (!existsSync(join(legacyRoot, "handoff.md"))) return;
		try {
			for (const name of ["handoff.md", "events.jsonl", "meta.json"] as const) {
				const from = join(legacyRoot, name);
				if (existsSync(from)) renameSync(from, join(this.root, name));
			}
		} catch {
			// best-effort — leave whatever moved in place, continue with fresh init
		}
	}

	/**
	 * One-time move from the pre-v0.4.0 flat layout (~/.agent/agent-handoff/<cwd-slug>/
	 * with handoff.md sitting directly inside the container) into this branch's
	 * subdirectory. Fires only when the branch store has no handoff.md yet but the
	 * container's flat handoff.md does, so it's safe to run every session and never
	 * clobbers a store already at the new path. Best-effort: a failure falls through
	 * to a fresh skeleton. The current branch inherits the pre-branch handoff;
	 * other branches start fresh.
	 */
	private migrateFlatToBranch(): void {
		if (existsSync(this.handoffPath)) return; // branch store already populated
		const container = dirname(this.root); // <storeHome>/<cwdSlug>
		const flatHandoff = join(container, "handoff.md");
		try {
			if (!existsSync(flatHandoff) || !statSync(flatHandoff).isFile()) return;
		} catch {
			return;
		}
		try {
			for (const name of ["handoff.md", "events.jsonl", "meta.json"] as const) {
				const from = join(container, name);
				if (existsSync(from) && statSync(from).isFile()) renameSync(from, join(this.root, name));
			}
		} catch {
			// best-effort
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
			this.turnsSinceRefresh++;
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
		this.turnsSinceRefresh = 0;
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
	 * DEFAULTS TO OFF for the shared store (see EVENTS_EXIT_CLEAR_LINES).
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

	/** Split a doc into the LLM-managed body and a trailing Pinned section.
	 * Pins now live in project.md; this remains for reading legacy handoff.md
	 * files (see migratePinnedToProject) and for stripping a stray section
	 * should the summarizer emit one despite being told not to. */
	splitPinned(doc: string): { body: string; pinned: string | null } {
		const idx = doc.search(/^# Pinned\s*$/m);
		if (idx < 0) return { body: doc, pinned: null };
		return { body: doc.slice(0, idx).trimEnd(), pinned: doc.slice(idx).trimEnd() + "\n" };
	}

	/** The project-level pinned doc, shared by every branch of this project. */
	readProjectDoc(): string {
		return this.readSafe(this.projectDocPath);
	}

	/** Pinned notes as bullet lines, excluding the placeholder. Empty when none. */
	pinnedNotes(): string[] {
		return this.readProjectDoc()
			.split("\n")
			.filter((l) => l.startsWith("- ") && !l.startsWith("- (pinned notes"))
			.map((l) => l.trim());
	}

	/** Assemble the final doc. Pins are no longer part of handoff.md — if the
	 * summarizer emitted a Pinned section anyway, drop it rather than persist a
	 * branch-local copy that would drift from project.md. */
	composeHandoff(llmBody: string): string {
		return `${this.splitPinned(llmBody).body.trimEnd()}\n`;
	}

	/** Append a durable note to the PROJECT-level pinned doc, so it survives
	 * branch switches and new branches inherit it. Returns false when the note
	 * is already pinned — re-noticing the same fact must not grow the file. */
	appendPinned(note: string): boolean {
		const clean = note.replace(/\n+/g, " ").trim();
		if (!clean) return false;
		const norm = (s: string) => s.replace(/^-\s*/, "").trim().toLowerCase();
		if (this.pinnedNotes().some((n) => norm(n) === norm(clean))) return false;
		const current = this.readProjectDoc().trimEnd() || DEFAULT_PINNED.trimEnd();
		this.atomicWriteSync(this.projectDocPath, `${current}\n- ${clean}\n`);
		return true;
	}

	/**
	 * Remove a pinned note by case-insensitive substring. Pins are project-wide
	 * and permanent, so an ambiguous match removes NOTHING and reports the
	 * candidates for the caller to disambiguate — deleting the wrong standing
	 * rule is worse than making the user type a longer match.
	 */
	removePinned(match: string): { removed: string | null; candidates: string[] } {
		const needle = match.trim().toLowerCase();
		const notes = this.pinnedNotes();
		const hits = needle ? notes.filter((n) => n.toLowerCase().includes(needle)) : [];
		if (hits.length !== 1) return { removed: null, candidates: hits };
		const kept = this.readProjectDoc()
			.split("\n")
			.filter((l) => l.trim() !== hits[0]);
		this.atomicWriteSync(this.projectDocPath, `${kept.join("\n").trimEnd()}\n`);
		return { removed: hits[0], candidates: [] };
	}

	/** One-time move of a legacy branch-local Pinned section into project.md.
	 * Runs on init for every branch store, so pins written before this version
	 * are recovered into the shared doc exactly once (duplicates are skipped,
	 * since several branches may each carry a copy). */
	private migratePinnedToProject(): void {
		const { body, pinned } = this.splitPinned(this.readHandoff());
		if (!pinned) return;
		const notes = pinned
			.split("\n")
			.filter((l) => l.startsWith("- ") && !l.startsWith("- (pinned notes"))
			.map((l) => l.trim());
		try {
			if (notes.length) {
				const have = new Set(this.pinnedNotes());
				const add = notes.filter((n) => !have.has(n));
				if (add.length) {
					const current = this.readProjectDoc().trimEnd() || DEFAULT_PINNED.trimEnd();
					this.atomicWriteSync(this.projectDocPath, `${current}\n${add.join("\n")}\n`);
				}
			}
			this.atomicWriteSync(this.handoffPath, `${body.trimEnd()}\n`);
		} catch {
			// best-effort — a failed migration must not block startup
		}
	}

	/** Write a refreshed handoff (snapshotting the old one into the log). llmBody must already be validated. */
	writeHandoff(llmBody: string, opts: { snapshot: boolean }): void {
		if (opts.snapshot) this.snapshot();
		this.atomicWriteSync(this.handoffPath, this.composeHandoff(llmBody));
	}

	/** Start a fresh handoff for a new task. Pins are untouched — they live in
	 * project.md and are not this branch's task state. */
	clearTaskState(): void {
		this.snapshot();
		this.atomicWriteSync(this.handoffPath, HANDOFF_SKELETON);
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
