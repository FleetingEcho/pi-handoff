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

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { redact } from "./redact";

export const HANDOFF_SECTIONS = [
	"Current Goal",
	"Progress",
	"Decisions",
	"Constraints",
	"Open Questions",
	"Active Files",
	"Next Steps",
] as const;

export const PROJECT_SECTIONS = [
	"Project Overview",
	"Architecture",
	"Conventions",
	"Workflows",
	"Decisions and Rationale",
	"Known Pitfalls",
] as const;
export type ProjectSection = (typeof PROJECT_SECTIONS)[number];
/** Shared knowledge is injected on every request, so keep it tighter than a
 * branch handoff. Pins are protected separately and do not count toward it. */
export const PROJECT_KNOWLEDGE_CAP_CHARS = 16_000;

/** Rough char budget (~6000 tokens @ ~4 chars/token). */
export const HANDOFF_CAP_CHARS = 24_000;
/** Cap on the serialized new-events payload fed to one refresh call. */
export const NEW_EVENTS_CAP_CHARS = 30_000;

/** Event-log trimming: oldest already-folded-in records are dropped in place. */
const EVENTS_MAX_BYTES = 4 * 1024 * 1024;
/** Trim down to this, not to the limit, so trimming is rare rather than constant. */
const EVENTS_TARGET_BYTES = 2 * 1024 * 1024;
const EVENTS_MAX_LINES = 1_000;
const EVENTS_TARGET_LINES = 900;
/** Reviewed candidates are only a dedupe/history aid; bound them so a project
 * used for years does not rewrite an ever-growing JSON file on every proposal. */
const PROJECT_CANDIDATE_HISTORY_MAX = 500;
const PROJECT_CANDIDATE_PENDING_MAX = 200;
const PROJECT_CANDIDATE_TEXT_MAX = 240;
const PROJECT_SCAN_HASH_MAX = 2_000;
const PIN_MAX_COUNT = 200;
const PIN_NOTE_MAX_CHARS = 500;
const PIN_TOTAL_MAX_CHARS = 16_000;
const HANDOFF_MAX_BYTES = 96 * 1024;
const PROJECT_DOC_MAX_BYTES = 128 * 1024;
const PROJECT_CANDIDATES_MAX_BYTES = 1024 * 1024;
const PROJECT_META_MAX_BYTES = 2 * 1024 * 1024;
const BRANCH_META_MAX_BYTES = 32 * 1024;
const WRITE_LOCK_TIMEOUT_MS = 5_000;
const WRITE_LOCK_STALE_MS = 30_000;
const LOCK_WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));

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
	"# Pinned Rules\n\n- (pinned notes are written by `/pi-handoff pin` and are never modified or removed by the summarizer)\n";

const PROJECT_SKELETON = `${PROJECT_SECTIONS.map((s) => `# ${s}\n`).join("\n")}\n${DEFAULT_PINNED}`;

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

/** Collision-free readable slug for newly-created branch stores. Existing
 * sanitized/hash-disambiguated stores remain supported by resolveStoreRoot. */
function encodedBranchSlug(branch: string): string {
	const encoded = encodeURIComponent(branch || "default").replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
	if (encoded.length <= SLUG_MAX) return encoded;
	const hash = createHash("sha256").update(branch).digest("hex").slice(0, 8);
	return `${encoded.slice(0, SLUG_MAX - hash.length - 1)}-${hash}`;
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
	const legacySlug = branchSlug(branch);
	const encodedSlug = encodedBranchSlug(branch);
	const legacyCandidate = join(container, legacySlug);
	const legacyOwner = existsSync(legacyCandidate) ? readMetaBranch(join(legacyCandidate, "meta.json")) : null;
	// Preserve the path of an existing pre-encoding store.
	if (legacyOwner === branch || (encodedSlug === legacySlug && !legacyOwner))
		return { root: legacyCandidate, projectPath: abs, cwdSlug, branchSlug: legacySlug };
	// Preserve the old collision-hash path if this branch already owns it.
	const oldHashed = `${legacySlug}-${createHash("sha256").update(branch).digest("hex").slice(0, 8)}`;
	if (readMetaBranch(join(container, oldHashed, "meta.json")) === branch)
		return { root: join(container, oldHashed), projectPath: abs, cwdSlug, branchSlug: oldHashed };
	const bSlug = encodedSlug;
	return { root: join(container, bSlug), projectPath: abs, cwdSlug, branchSlug: bSlug };
}

/** Project identity recorded by any initialized branch inside a container. */
function readContainerProjectPath(container: string): string | null {
	try {
		for (const ent of readdirSync(container, { withFileTypes: true })) {
			if (!ent.isDirectory()) continue;
			try {
				const meta = JSON.parse(readFileSync(join(container, ent.name, "meta.json"), "utf8")) as Partial<Meta>;
				if (typeof meta.projectPath === "string" && meta.projectPath) return meta.projectPath;
			} catch {
				// An uninitialized/corrupt branch cannot establish container identity.
			}
		}
	} catch {
		// Missing container is the normal first-run case.
	}
	return null;
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
	let cwdSlug = pathSlug(abs);
	let container = join(storeHome(), cwdSlug);
	const existingPath = readContainerProjectPath(container);
	if (existingPath && existingPath !== abs) {
		cwdSlug = `${cwdSlug}-${createHash("sha256").update(abs).digest("hex").slice(0, 8)}`;
		container = join(storeHome(), cwdSlug);
	}
	return { abs, cwdSlug, container };
}

export interface BranchDoc {
	/** True branch name from the store's meta.json (directory slug as fallback). */
	branch: string;
	path: string;
	doc: string;
}

export interface ProjectCandidate {
	id: string;
	section: ProjectSection;
	statement: string;
	evidence: string;
	branches: string[];
	createdAt: string;
	status: "suggested" | "accepted" | "rejected";
	action?: "add" | "replace" | "remove";
	/** Exact existing bullet statement for replace/remove. */
	target?: string;
}

function normalizeProjectCandidate(value: unknown): ProjectCandidate | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	const statement = redact(String(raw.statement ?? "").replace(/\s+/g, " ").trim()).slice(0, PROJECT_CANDIDATE_TEXT_MAX).trim();
	if (!statement) return null;
	const section = PROJECT_SECTIONS.includes(raw.section as ProjectSection) ? raw.section as ProjectSection : "Conventions";
	const action = raw.action === "replace" || raw.action === "remove" ? raw.action : "add";
	const target = action === "add" ? undefined : redact(String(raw.target ?? "").replace(/^-\s*/, "").replace(/\s+/g, " ").trim()).slice(0, PROJECT_CANDIDATE_TEXT_MAX);
	const rawId = typeof raw.id === "string" ? raw.id.slice(0, 64) : "";
	return {
		id: rawId || createHash("sha256").update(`${action}\0${target ?? ""}\0${statement}`).digest("hex").slice(0, 16),
		section,
		statement,
		evidence: redact(String(raw.evidence ?? "").replace(/\s+/g, " ").trim()).slice(0, PROJECT_CANDIDATE_TEXT_MAX),
		branches: Array.isArray(raw.branches) ? raw.branches.filter((branch): branch is string => typeof branch === "string").slice(0, 12).map((branch) => branch.slice(0, 512)) : [],
		createdAt: typeof raw.createdAt === "string" ? raw.createdAt.slice(0, 64) : new Date().toISOString(),
		status: raw.status === "accepted" || raw.status === "rejected" ? raw.status : "suggested",
		action,
		target,
	};
}

/**
 * Read every branch handoff of the PROJECT that owns `cwd` — all branch
 * subdirectories under the project container, plus the pre-v0.4.0 flat
 * handoff.md if it still carries content. Docs without real content (fresh
 * skeletons) are skipped. Read-only; feeds project knowledge extraction.
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
		// whatever was readable is enough for best-effort project extraction
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
	eventLineCount: number;
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
		eventLineCount: 0,
		summarizerUsage: { calls: 0, totalTokens: 0 },
		enabled: true,
		updatedAt: now,
	};
}

function normalizeMeta(value: unknown): Meta {
	const base = defaultMeta();
	if (!value || typeof value !== "object") return base;
	const raw = value as Record<string, any>;
	const finiteInt = (input: unknown, fallback: number, min = 0) =>
		typeof input === "number" && Number.isFinite(input) ? Math.max(min, Math.floor(input)) : fallback;
	const text = (input: unknown, fallback = "", max = 4_096) => typeof input === "string" ? input.slice(0, max) : fallback;
	const usage = raw.summarizerUsage && typeof raw.summarizerUsage === "object" ? raw.summarizerUsage : {};
	return {
		schemaVersion: finiteInt(raw.schemaVersion, base.schemaVersion, 1),
		projectPath: text(raw.projectPath),
		branch: text(raw.branch),
		createdAt: text(raw.createdAt, base.createdAt, 64),
		sessionId: text(raw.sessionId, "", 256),
		pid: finiteInt(raw.pid, 0),
		endedAt: text(raw.endedAt, "", 64),
		nextSeq: finiteInt(raw.nextSeq, 1, 1),
		lastCollectedSeq: finiteInt(raw.lastCollectedSeq, 0),
		lastRefreshedSeq: finiteInt(raw.lastRefreshedSeq, 0),
		eventLineCount: finiteInt(raw.eventLineCount, 0),
		summarizerUsage: {
			calls: finiteInt(usage.calls, 0),
			totalTokens: finiteInt(usage.totalTokens, 0),
		},
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
		updatedAt: text(raw.updatedAt, base.updatedAt, 64),
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
	readonly projectCandidatesPath: string;
	readonly projectMetaPath: string;
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
	private heldLocks = new Map<string, number>();

	constructor(root: string, projectPath = "", branch = "", cwdSlug = "") {
		this.root = root;
		this.projectPath = projectPath;
		this.branch = branch;
		this.cwdSlug = cwdSlug;
		this.handoffPath = join(root, "handoff.md");
		this.eventsPath = join(root, "events.jsonl");
		this.metaPath = join(root, "meta.json");
		this.projectDocPath = join(dirname(root), "project.md");
		this.projectCandidatesPath = join(dirname(root), "project-candidates.json");
		this.projectMetaPath = join(dirname(root), "project-meta.json");
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
		this.withBranchWriteLock(() => {
			this.migrateFromLegacyRoot();
			this.migrateFlatToBranch();
			// Migrate legacy uppercase filename → lowercase. On a case-sensitive FS
			// (Linux) the two are distinct files; on macOS/Windows this is a no-op.
			const legacy = join(this.root, "HANDOFF.md");
			if (!existsSync(this.handoffPath) && existsSync(legacy)) {
				try { renameSync(legacy, this.handoffPath); } catch { /* best-effort */ }
			}
			if (!existsSync(this.eventsPath)) writeFileSync(this.eventsPath, "");
			if (!existsSync(this.handoffPath)) this.atomicWriteSync(this.handoffPath, HANDOFF_SKELETON);
		});
		this.withProjectWriteLock(() => {
			if (!existsSync(this.projectDocPath)) this.atomicWriteSync(this.projectDocPath, PROJECT_SKELETON);
			this.ensureProjectLayout();
			this.saveProjectCandidates(this.readProjectCandidates());
			this.saveProjectScanHashes({});
		});
		this.withBranchWriteLock(() => this.withProjectWriteLock(() => this.migratePinnedToProject()));
		this.withBranchWriteLock(() => {
			this.meta = this.loadMeta();
			if (this.meta.projectPath && this.projectPath && this.meta.projectPath !== this.projectPath)
				throw new Error(`pi-handoff: store collision (${this.meta.projectPath} vs ${this.projectPath}); restart to use a disambiguated store`);
			if (this.meta.branch && this.branch && this.meta.branch !== this.branch)
				throw new Error(`pi-handoff: branch store collision (${this.meta.branch} vs ${this.branch}); restart to use the encoded branch store`);
			let changed = false;
			const events = this.readEventsSince(-1);
			const eventLineCount = this.readSafe(this.eventsPath).split("\n").filter((line) => line.trim()).length;
			const maxSeq = events.reduce((max, event) => Math.max(max, event.seq), 0);
			const lastCollected = events.reduce((max, event) => event.type === "turn_end" ? Math.max(max, event.seq) : max, 0);
			if (this.meta.nextSeq <= maxSeq) {
				this.meta.nextSeq = maxSeq + 1;
				changed = true;
			}
			if (this.meta.lastCollectedSeq < lastCollected) {
				this.meta.lastCollectedSeq = lastCollected;
				changed = true;
			}
			if (this.meta.eventLineCount !== eventLineCount) {
				this.meta.eventLineCount = eventLineCount;
				changed = true;
			}
			if (!this.meta.projectPath && this.projectPath) {
				this.meta.projectPath = this.projectPath;
				changed = true;
			}
			if (!this.meta.branch && this.branch) {
				this.meta.branch = this.branch;
				changed = true;
			}
			this.maybeTrimEvents();
			this.saveMetaUnlocked(); // always rewrite normalized known fields only
		});
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
			return normalizeMeta(JSON.parse(raw));
		} catch {
			return defaultMeta();
		}
	}

	saveMetaSync(): void {
		this.withBranchWriteLock(() => {
			const disk = this.loadMeta();
			this.meta.nextSeq = Math.max(this.meta.nextSeq, disk.nextSeq);
			this.meta.lastCollectedSeq = Math.max(this.meta.lastCollectedSeq, disk.lastCollectedSeq);
			this.meta.lastRefreshedSeq = Math.max(this.meta.lastRefreshedSeq, disk.lastRefreshedSeq);
			this.meta.eventLineCount = disk.eventLineCount;
			this.saveMetaUnlocked();
		});
	}

	private saveMetaUnlocked(): void {
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
		return this.withBranchWriteLock(() => {
			const disk = this.loadMeta();
			this.meta.nextSeq = Math.max(this.meta.nextSeq, disk.nextSeq);
			this.meta.lastCollectedSeq = Math.max(this.meta.lastCollectedSeq, disk.lastCollectedSeq);
			this.meta.lastRefreshedSeq = Math.max(this.meta.lastRefreshedSeq, disk.lastRefreshedSeq);
			this.meta.eventLineCount = disk.eventLineCount;
			const full: HandoffEvent = {
				schemaVersion: 2,
				seq: this.meta.nextSeq++,
				timestamp: new Date().toISOString(),
				...ev,
			};
			appendFileSync(this.eventsPath, JSON.stringify(full) + "\n");
			this.meta.eventLineCount++;
			if (full.type === "turn_end") {
				this.meta.lastCollectedSeq = full.seq;
				this.pendingChars += (full.excerpts ?? []).reduce((n, e) => n + e.text.length, 0);
				this.turnsSinceRefresh++;
			}
			this.maybeTrimEvents();
			this.saveMetaUnlocked();
			return full;
		});
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
		this.withBranchWriteLock(() => {
			const disk = this.loadMeta();
			this.meta.nextSeq = Math.max(this.meta.nextSeq, disk.nextSeq);
			this.meta.lastCollectedSeq = Math.max(this.meta.lastCollectedSeq, disk.lastCollectedSeq);
			this.meta.lastRefreshedSeq = Math.max(throughSeq, disk.lastRefreshedSeq);
			this.meta.eventLineCount = disk.eventLineCount;
			// New events may arrive while the model runs; rebuild from the durable log.
			const remaining = this.readEventsSince(this.meta.lastRefreshedSeq).filter((e) => e.type === "turn_end");
			this.pendingChars = remaining.reduce(
				(n, e) => n + (e.excerpts ?? []).reduce((m, excerpt) => m + excerpt.text.length, 0),
				0,
			);
			this.turnsSinceRefresh = remaining.length;
			this.saveMetaUnlocked();
		});
	}

	recordUsage(usage?: { input?: number; output?: number; totalTokens?: number }): void {
		if (!usage) return;
		this.withBranchWriteLock(() => {
			const disk = this.loadMeta();
			this.meta.nextSeq = Math.max(this.meta.nextSeq, disk.nextSeq);
			this.meta.lastCollectedSeq = Math.max(this.meta.lastCollectedSeq, disk.lastCollectedSeq);
			this.meta.lastRefreshedSeq = Math.max(this.meta.lastRefreshedSeq, disk.lastRefreshedSeq);
			this.meta.eventLineCount = disk.eventLineCount;
			this.meta.summarizerUsage = {
				calls: disk.summarizerUsage.calls + 1,
				totalTokens: disk.summarizerUsage.totalTokens + (usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0)),
			};
			this.saveMetaUnlocked();
		});
	}

	/**
	 * Keep the log below both the line and byte hard limits. Folded records are
	 * discarded first naturally because they are oldest. If pending history alone
	 * exceeds the hard limit, retain the newest records and insert a visible turn
	 * marker so the summarizer knows older pending detail was capacity-dropped.
	 */
	private maybeTrimEvents(): void {
		try {
			if (this.meta.eventLineCount <= EVENTS_MAX_LINES && statSync(this.eventsPath).size <= EVENTS_MAX_BYTES) return;
			const lines = this.readSafe(this.eventsPath).split("\n").filter((l) => l.trim());
			// Walk back from newest, retaining a comfortable target rather than
			// trimming one line on every subsequent append.
			let cut = lines.length;
			let keptBytes = 0;
			let keptLines = 0;
			while (
				cut > 0 &&
				keptLines < EVENTS_TARGET_LINES &&
				keptBytes + Buffer.byteLength(lines[cut - 1], "utf8") + 1 <= EVENTS_TARGET_BYTES
			) {
				keptBytes += Buffer.byteLength(lines[cut - 1], "utf8") + 1;
				keptLines++;
				cut--;
			}
			if (cut === 0) return;
			const dropped = lines.slice(0, cut);
			const kept = lines.slice(cut);
			const pendingDropped = dropped.reduce((count, line) => {
				try {
					const event = JSON.parse(line) as HandoffEvent;
					return event.seq > this.meta.lastRefreshedSeq && (event.type === "turn_end" || event.type === "pin") ? count + 1 : count;
				} catch {
					return count;
				}
			}, 0);
			if (pendingDropped > 0) {
				const firstKeptSeq = kept.length ? seqOf(kept[0]) : null;
				const marker: HandoffEvent = {
					schemaVersion: 2,
					seq: firstKeptSeq !== null ? Math.max(this.meta.lastRefreshedSeq + 0.1, firstKeptSeq - 0.5) : this.meta.lastRefreshedSeq + 0.1,
					sessionId: this.meta.sessionId,
					turn: -1,
					timestamp: new Date().toISOString(),
					type: "turn_end",
					excerpts: [{ role: "tool", toolName: "pi-handoff", text: `[${pendingDropped} older pending event record(s) were dropped to keep events.jsonl within ${EVENTS_MAX_LINES} lines / ${EVENTS_MAX_BYTES} bytes]` }],
				};
				kept.unshift(JSON.stringify(marker));
			}
			this.atomicWriteSync(this.eventsPath, kept.join("\n") + "\n");
			this.meta.eventLineCount = kept.length;
			const remaining = this.readEventsSince(this.meta.lastRefreshedSeq).filter((event) => event.type === "turn_end");
			this.pendingChars = remaining.reduce((total, event) => total + (event.excerpts ?? []).reduce((n, excerpt) => n + excerpt.text.length, 0), 0);
			this.turnsSinceRefresh = remaining.length;
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
		return this.withBranchWriteLock(() => {
			try {
				const lines = this.readSafe(this.eventsPath).split("\n").filter((l) => l.trim());
				if (lines.length < EVENTS_EXIT_CLEAR_LINES) return false;
				this.atomicWriteSync(this.eventsPath, "");
				this.meta.eventLineCount = 0;
				this.saveMetaUnlocked();
				return true;
			} catch {
				return false;
			}
		});
	}

	// ------------------------------------------------------- curated document

	/** Split a doc into the LLM-managed body and a trailing Pinned section.
	 * Pins now live in project.md; this remains for reading legacy handoff.md
	 * files (see migratePinnedToProject) and for stripping a stray section
	 * should the summarizer emit one despite being told not to. */
	splitPinned(doc: string): { body: string; pinned: string | null } {
		const idx = doc.search(/^# Pinned(?: Rules)?\s*$/m);
		if (idx < 0) return { body: doc, pinned: null };
		return { body: doc.slice(0, idx).trimEnd(), pinned: doc.slice(idx).trimEnd() + "\n" };
	}

	/** The project-level pinned doc, shared by every branch of this project. */
	readProjectDoc(): string {
		return this.readSafe(this.projectDocPath);
	}

	/** Model-maintained, project-wide knowledge without the protected pin block. */
	readProjectKnowledge(): string {
		return this.splitPinned(this.readProjectDoc()).body.trim();
	}

	private ensureProjectLayout(): void {
		const current = this.readProjectDoc();
		const { body, pinned } = this.splitPinned(current);
		const hasManagedSections = PROJECT_SECTIONS.every((s) => new RegExp(`^# ${s}\\s*$`, "m").test(body));
		const managed = this.fitProjectKnowledge(
			hasManagedSections ? body.trimEnd() : PROJECT_SECTIONS.map((s) => `# ${s}\n`).join("\n").trimEnd(),
		);
		const protectedPins = this.fitPinnedBlock(pinned ?? (current || DEFAULT_PINNED));
		this.atomicWriteSync(this.projectDocPath, `${managed}\n\n${protectedPins}\n`);
	}

	private fitPinnedBlock(block: string): string {
		const rawNotes = block.split("\n").filter((line) => line.startsWith("- ") && !line.startsWith("- (pinned notes") && !line.startsWith("- (pi-handoff:"));
		const notes: string[] = [];
		const seen = new Set<string>();
		let chars = 0;
		for (const raw of rawNotes) {
			const note = redact(raw.replace(/^-\s*/, "").replace(/\s+/g, " ").trim()).slice(0, PIN_NOTE_MAX_CHARS).trim();
			const key = note.toLowerCase();
			if (!note || seen.has(key) || notes.length >= PIN_MAX_COUNT || chars + note.length + 3 > PIN_TOTAL_MAX_CHARS) continue;
			seen.add(key);
			notes.push(note);
			chars += note.length + 3;
		}
		const dropped = rawNotes.length - notes.length;
		return [
			"# Pinned Rules",
			"",
			...(notes.length ? notes.map((note) => `- ${note}`) : ["- (pinned notes are written by `/pi-handoff pin` and are never modified or removed by the summarizer)"]),
			...(dropped ? [`- (pi-handoff: ${dropped} duplicate/overflow pinned rule(s) removed to enforce storage limits)`] : []),
		].join("\n");
	}

	private fitProjectKnowledge(body: string): string {
		if (body.length <= PROJECT_KNOWLEDGE_CAP_CHARS) return body;
		const sections = PROJECT_SECTIONS.map((section, index) => {
			const heading = `# ${section}`;
			const start = body.indexOf(heading) + heading.length;
			const next = index + 1 < PROJECT_SECTIONS.length ? body.indexOf(`# ${PROJECT_SECTIONS[index + 1]}`, start) : body.length;
			return body.slice(start, next < 0 ? body.length : next).trim();
		});
		const headingsBytes = PROJECT_SECTIONS.reduce((total, section) => total + section.length + 5, 0);
		const marker = "\n\n[...section compacted by pi-handoff]";
		const budget = Math.floor((PROJECT_KNOWLEDGE_CAP_CHARS - headingsBytes) / PROJECT_SECTIONS.length);
		return PROJECT_SECTIONS.map((section, index) => {
			const content = sections[index];
			const fitted = content.length <= budget ? content : content.slice(0, Math.max(0, budget - marker.length)).trimEnd() + marker;
			return `# ${section}\n${fitted}`.trimEnd();
		}).join("\n\n");
	}

	/** Pinned notes as bullet lines, excluding the placeholder. Empty when none. */
	pinnedNotes(): string[] {
		return (this.splitPinned(this.readProjectDoc()).pinned ?? "")
			.split("\n")
			.filter((l) => l.startsWith("- ") && !l.startsWith("- (pinned notes") && !l.startsWith("- (pi-handoff:"))
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
		return this.withProjectWriteLock(() => {
			const clean = redact(note.replace(/\n+/g, " ").trim()).replace(/^-\s*/, "").slice(0, PIN_NOTE_MAX_CHARS).trim();
			if (!clean) return false;
			const norm = (s: string) => s.replace(/^-\s*/, "").trim().toLowerCase();
			const pins = this.pinnedNotes();
			if (pins.some((n) => norm(n) === norm(clean))) return false;
			if (pins.length >= PIN_MAX_COUNT || pins.reduce((total, pin) => total + pin.length + 1, 0) + clean.length + 3 > PIN_TOTAL_MAX_CHARS)
				return false;
			const current = this.readProjectDoc().trimEnd() || DEFAULT_PINNED.trimEnd();
			this.atomicWriteSync(this.projectDocPath, `${current}\n- ${clean}\n`);
			return true;
		});
	}

	/**
	 * Remove a pinned note by case-insensitive substring. Pins are project-wide
	 * and permanent, so an ambiguous match removes NOTHING and reports the
	 * candidates for the caller to disambiguate — deleting the wrong standing
	 * rule is worse than making the user type a longer match.
	 */
	removePinned(match: string): { removed: string | null; candidates: string[] } {
		return this.withProjectWriteLock(() => {
			const needle = match.trim().toLowerCase();
			const notes = this.pinnedNotes();
			const hits = needle ? notes.filter((n) => n.toLowerCase().includes(needle)) : [];
			if (hits.length !== 1) return { removed: null, candidates: hits };
			const { body, pinned } = this.splitPinned(this.readProjectDoc());
			const kept = (pinned ?? DEFAULT_PINNED).split("\n").filter((l) => l.trim() !== hits[0]);
			this.atomicWriteSync(this.projectDocPath, `${body.trimEnd()}\n\n${kept.join("\n").trimEnd()}\n`);
			return { removed: hits[0], candidates: [] };
		});
	}

	/** Insert one reviewed fact into the requested managed project section. */
	appendProjectKnowledge(section: ProjectSection, statement: string): boolean {
		return this.withProjectWriteLock(() => {
			const clean = redact(statement.replace(/\n+/g, " ").trim());
			if (!clean || !PROJECT_SECTIONS.includes(section)) return false;
			const norm = (s: string) => s.replace(/^-\s*/, "").trim().toLowerCase();
			const { body, pinned } = this.splitPinned(this.readProjectDoc());
			if (body.split("\n").some((line) => line.startsWith("- ") && norm(line) === norm(clean))) return false;
			const heading = `# ${section}`;
			const start = body.indexOf(heading);
			if (start < 0) return false;
			const nextHeading = body.indexOf("\n# ", start + heading.length);
			const insertAt = nextHeading < 0 ? body.length : nextHeading;
			const updated = `${body.slice(0, insertAt).trimEnd()}\n- ${clean}\n\n${body.slice(insertAt).trimStart()}`.trimEnd();
			if (updated.length > PROJECT_KNOWLEDGE_CAP_CHARS) return false;
			this.atomicWriteSync(this.projectDocPath, `${updated}\n\n${(pinned ?? DEFAULT_PINNED).trimEnd()}\n`);
			return true;
		});
	}

	/** Apply one reviewed project change against the current document. */
	applyProjectCandidate(candidate: ProjectCandidate): { applied: boolean; reason?: string } {
		return this.withProjectWriteLock(() => {
			const action = candidate.action ?? "add";
			if (action === "add") {
				const applied = this.appendProjectKnowledge(candidate.section, candidate.statement);
				return { applied, reason: applied ? undefined : "already present or project knowledge is at its size limit" };
			}
			const target = candidate.target?.replace(/^-\s*/, "").trim();
			if (!target) return { applied: false, reason: `${action} candidate has no target` };
			const { body, pinned } = this.splitPinned(this.readProjectDoc());
			const lines = body.split("\n");
			const index = lines.findIndex((line) => line.startsWith("- ") && line.slice(2).trim() === target);
			if (index < 0) return { applied: false, reason: "target no longer exists" };
			if (action === "remove") {
				lines.splice(index, 1);
			} else {
				const replacement = redact(candidate.statement.replace(/\n+/g, " ").trim());
				if (!replacement) return { applied: false, reason: "replacement is empty" };
				lines[index] = `- ${replacement}`;
			}
			const updated = lines.join("\n").trimEnd();
			if (updated.length > PROJECT_KNOWLEDGE_CAP_CHARS) return { applied: false, reason: "project knowledge is at its size limit" };
			this.atomicWriteSync(this.projectDocPath, `${updated}\n\n${(pinned ?? DEFAULT_PINNED).trimEnd()}\n`);
			return { applied: true };
		});
	}

	removeProjectKnowledge(match: string): { removed: string | null; candidates: string[] } {
		return this.withProjectWriteLock(() => {
			const needle = match.trim().toLowerCase();
			const { body, pinned } = this.splitPinned(this.readProjectDoc());
			const facts = body.split("\n").filter((line) => line.startsWith("- "));
			const hits = needle ? facts.filter((line) => line.toLowerCase().includes(needle)) : [];
			if (hits.length !== 1) return { removed: null, candidates: hits };
			const updated = body.split("\n").filter((line) => line !== hits[0]).join("\n").trimEnd();
			this.atomicWriteSync(this.projectDocPath, `${updated}\n\n${(pinned ?? DEFAULT_PINNED).trimEnd()}\n`);
			return { removed: hits[0], candidates: [] };
		});
	}

	readProjectCandidates(): ProjectCandidate[] {
		try {
			const parsed = JSON.parse(this.readSafe(this.projectCandidatesPath));
			return Array.isArray(parsed) ? parsed.map(normalizeProjectCandidate).filter((candidate): candidate is ProjectCandidate => candidate !== null) : [];
		} catch {
			return [];
		}
	}

	saveProjectCandidates(candidates: ProjectCandidate[]): void {
		this.withProjectWriteLock(() => {
			// Merge with disk so another branch/session cannot lose a proposal while
			// this caller was reviewing or extracting its own batch.
			const merged = new Map(this.readProjectCandidates().map((candidate) => [candidate.id, candidate]));
			for (const candidate of candidates) {
				const onDisk = merged.get(candidate.id);
				if (onDisk && onDisk.status !== "suggested" && candidate.status === "suggested") continue;
				if (onDisk?.status === "accepted" && candidate.status === "rejected") continue;
				merged.set(candidate.id, candidate);
			}
			const all = [...merged.values()].map(normalizeProjectCandidate).filter((candidate): candidate is ProjectCandidate => candidate !== null);
			const suggested = all
				.filter((candidate) => candidate.status === "suggested")
				.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))
				.slice(0, PROJECT_CANDIDATE_PENDING_MAX);
			const reviewed = all
				.filter((candidate) => candidate.status !== "suggested")
				.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))
				.slice(0, PROJECT_CANDIDATE_HISTORY_MAX);
			this.atomicWriteSync(this.projectCandidatesPath, JSON.stringify([...suggested, ...reviewed], null, 2) + "\n");
		});
	}

	projectScanHashes(): Record<string, string> {
		try {
			const parsed = JSON.parse(this.readSafe(this.projectMetaPath)) as { branchHashes?: Record<string, string> };
			if (!parsed.branchHashes || typeof parsed.branchHashes !== "object") return {};
			return Object.fromEntries(
				Object.entries(parsed.branchHashes)
					.filter(([branch, hash]) => !!branch && typeof hash === "string")
					.slice(-PROJECT_SCAN_HASH_MAX)
					.map(([branch, hash]) => [branch.slice(0, 512), hash.slice(0, 128)]),
			);
		} catch {
			return {};
		}

	}

	saveProjectScanHashes(branchHashes: Record<string, string>): void {
		this.withProjectWriteLock(() => {
			const merged = new Map(Object.entries(this.projectScanHashes()));
			for (const [branch, hash] of Object.entries(branchHashes)) {
				const cleanBranch = branch.slice(0, 512);
				merged.delete(cleanBranch);
				merged.set(cleanBranch, String(hash).slice(0, 128));
			}
			const bounded = Object.fromEntries([...merged.entries()].slice(-PROJECT_SCAN_HASH_MAX));
			this.atomicWriteSync(this.projectMetaPath, JSON.stringify({ schemaVersion: 1, branchHashes: bounded, updatedAt: new Date().toISOString() }, null, 2) + "\n");
		});
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
			for (const note of notes) this.appendPinned(note);
			this.atomicWriteSync(this.handoffPath, `${body.trimEnd()}\n`);
		} catch {
			// best-effort — a failed migration must not block startup
		}
	}

	/** Write a refreshed handoff (snapshotting the old one into the log). */
	writeHandoff(llmBody: string, opts: { snapshot: boolean; expectedCurrent?: string }): void {
		this.withBranchWriteLock(() => {
			if (opts.expectedCurrent !== undefined && this.readHandoff() !== opts.expectedCurrent)
				throw new Error("pi-handoff: handoff changed during refresh; retrying against the newer document");
			const composed = this.composeHandoff(llmBody);
			if (composed.length > HANDOFF_CAP_CHARS) throw new Error(`pi-handoff: handoff exceeds ${HANDOFF_CAP_CHARS} characters`);
			if (opts.snapshot) this.snapshot();
			this.atomicWriteSync(this.handoffPath, composed);
		});
	}

	/** Start a fresh handoff for a new task. Pins are untouched — they live in
	 * project.md and are not this branch's task state. */
	clearTaskState(): void {
		this.withBranchWriteLock(() => {
			this.snapshot();
			this.atomicWriteSync(this.handoffPath, HANDOFF_SKELETON);
		});
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

	private withBranchWriteLock<T>(fn: () => T): T {
		return this.withWriteLock(join(this.root, ".write-lock"), fn);
	}

	private withProjectWriteLock<T>(fn: () => T): T {
		return this.withWriteLock(join(dirname(this.root), ".project-write-lock"), fn);
	}

	private withWriteLock<T>(lockPath: string, fn: () => T): T {
		const depth = this.heldLocks.get(lockPath) ?? 0;
		if (depth > 0) {
			this.heldLocks.set(lockPath, depth + 1);
			try { return fn(); } finally { this.heldLocks.set(lockPath, depth); }
		}
		const deadline = Date.now() + WRITE_LOCK_TIMEOUT_MS;
		while (true) {
			try {
				mkdirSync(lockPath);
				break;
			} catch (error: any) {
				if (error?.code !== "EEXIST") throw error;
				try {
					if (Date.now() - statSync(lockPath).mtimeMs > WRITE_LOCK_STALE_MS) {
						rmdirSync(lockPath);
						continue;
					}
				} catch {
					continue; // lock disappeared between checks
				}
				if (Date.now() >= deadline) throw new Error(`pi-handoff: timed out waiting for write lock ${lockPath}`);
				Atomics.wait(LOCK_WAIT_ARRAY, 0, 0, 20);
			}
		}
		this.heldLocks.set(lockPath, 1);
		try {
			return fn();
		} finally {
			this.heldLocks.delete(lockPath);
			try { rmdirSync(lockPath); } catch { /* stale-lock recovery may have raced; next operation retries */ }
		}
	}

	private atomicWriteSync(path: string, content: string): void {
		const maxBytes = path === this.handoffPath
			? HANDOFF_MAX_BYTES
			: path === this.projectDocPath
				? PROJECT_DOC_MAX_BYTES
				: path === this.projectCandidatesPath
					? PROJECT_CANDIDATES_MAX_BYTES
					: path === this.projectMetaPath
						? PROJECT_META_MAX_BYTES
						: path === this.metaPath
							? BRANCH_META_MAX_BYTES
							: path === this.eventsPath
								? EVENTS_MAX_BYTES
								: Number.POSITIVE_INFINITY;
		const bytes = Buffer.byteLength(content, "utf8");
		if (bytes > maxBytes) throw new Error(`pi-handoff: refusing to write ${bytes} bytes to ${path} (limit ${maxBytes})`);
		// PID alone is not unique when pi hosts multiple sessions in one process.
		const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
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
