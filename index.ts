/**
 * pi-handoff — a self-maintaining handoff.md per project + git branch, stored
 * outside the project.
 *
 * Each project gets its own store under ~/.agent/agent-handoff/, named after
 * the project root's absolute path (see resolveStoreRoot) — the git repo /
 * worktree top-level when the working directory is inside a repo, so opening
 * from a subdirectory of the same repo lands on the SAME store; outside git
 * the working directory itself is the key. Each git branch gets its own
 * subdirectory within it. Nothing is written into the repository itself.
 *
 *   events.jsonl   append-only log, written by the collector (no LLM)
 *   handoff.md     the document, refreshed in the background as work happens
 *
 * The branch is detected at session start and re-checked at the start of every
 * turn, so a mid-session `git checkout` swaps to that branch's handoff. A
 * non-git directory uses a single "default" branch.
 *
 * Recall: every LLM call gets the current document injected via the `context`
 * event (non-destructive, never persisted into the session).
 *
 * The agent curates the shared project.md itself through the `handoff` tool
 * (status|flush|pin|unpin) — the same write surface opencode-handoff exposes,
 * so a standing rule noticed by either agent is visible to both. Task clears
 * and on/off stay user-only (slash commands); the agent may curate memory but
 * never wipe it.
 *
 * Commands: /pi-handoff status|flush|pin|unpin|distill|clear|on|off
 * Tool:     handoff(status|flush|pin|unpin) — agent-callable
 * Env:      PI_HANDOFF_MODEL=provider/id  PI_HANDOFF_THRESHOLD_CHARS=8000
 *           PI_HANDOFF_THRESHOLD_TURNS=3  PI_HANDOFF_DIR=<dir>  PI_HANDOFF_DEBUG=1
 */

import { execSync } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Collector } from "./collector";
import { Injector } from "./injector";
import { HandoffStore, listBranchDocs, migrateProjectKey } from "./store";
import { runDistill, runRefresh } from "./summarizer";

/** Character ceiling: force an early refresh once this many new chars accumulate,
 * even before the turn backstop fires — a safety valve for heavy/monster turns. */
const CHAR_THRESHOLD = Math.max(200, Number(process.env.PI_HANDOFF_THRESHOLD_CHARS ?? 8_000) || 8_000);
/** Turn backstop: auto-refresh every this many turns. 0 disables it (chars only). */
const TURN_THRESHOLD = (() => {
	const n = Math.floor(Number(process.env.PI_HANDOFF_THRESHOLD_TURNS ?? 3));
	return Number.isFinite(n) && n >= 0 ? n : 3;
})();
const REFRESH_TIMEOUT_MS = 120_000;
/** Max wait for an in-flight refresh to settle on shutdown (abort fires first; this is a backstop). */
const SHUTDOWN_GRACE_MS = 2_000;

/** True when enough un-folded work has accumulated to justify an auto-refresh:
 * every TURN_THRESHOLD turns (the primary cadence) or CHAR_THRESHOLD chars
 * (a safety valve that fires early on heavy turns). The turn backstop is
 * disabled when TURN_THRESHOLD=0, leaving only the char ceiling. */
function shouldAutoRefresh(chars: number, turns: number): boolean {
	return (TURN_THRESHOLD > 0 && turns >= TURN_THRESHOLD) || chars >= CHAR_THRESHOLD;
}

type Ctx = ExtensionContext;

/** True if a process with `pid` is still running (best-effort: false if dead or unknown). */
function isPidAlive(pid: number): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0); // signal 0 = existence check, no signal sent
		return true;
	} catch (e: any) {
		// ESRCH: no such process → dead. EPERM: exists but no permission → alive.
		return e?.code === "EPERM";
	}
}

/** cwd -> project root cache: repo membership of a directory doesn't change mid-session. */
const projectRootCache = new Map<string, string>();

/**
 * The identity of "the project": the git repo/worktree top-level when `cwd`
 * is inside one, else `cwd` itself. Opening the agent from a SUBDIRECTORY of
 * the repo must not mint a second project with its own handoffs and pins —
 * the repo is the project, wherever inside it you stood when you launched.
 * Cached per cwd; a `git init` mid-session is picked up on the next session.
 */
export function resolveProjectRoot(cwd: string): string {
	const hit = projectRootCache.get(cwd);
	if (hit) return hit;
	let root = cwd;
	try {
		const top = execSync("git rev-parse --show-toplevel", {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
			encoding: "utf8",
			timeout: 2000,
		}).trim();
		if (top) root = top;
	} catch {
		// not a repo — the working directory itself is the project
	}
	projectRootCache.set(cwd, root);
	return root;
}

/**
 * Best-effort current git branch of `cwd`. Returns "default" when not in a repo
 * or on any error, and "detached-<short-sha>" for detached HEAD. Cheap (no FS
 * walk); called once per turn, so a mid-session `git checkout` is picked up.
 *
 * The name comes from the FULL symbolic ref on purpose: `rev-parse
 * --abbrev-ref` and `symbolic-ref --short` both apply git's ref-shortening
 * rules, which answer "heads/<name>" whenever the short name is ambiguous
 * (a tag sharing the branch's name) and revert to the bare name once the
 * ambiguity disappears — flipping one branch between two store dirs and
 * making its handoff look blank. `refs/heads/<name>` is identical in both
 * states, so we strip the prefix ourselves.
 */
export function detectBranch(cwd: string): string {
	const run = (args: string) =>
		execSync(args, { cwd, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", timeout: 2000 }).trim();
	try {
		// symbolic-ref exits non-zero on a detached HEAD — that is the normal
		// case, not an error, so it gets its own try instead of failing the whole probe.
		let ref = "";
		try {
			ref = run("git symbolic-ref -q HEAD");
		} catch {
			// detached
		}
		if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
		if (ref) return ref.replace(/^refs\//g, ""); // exotic ref (notes, worktree...) — still deterministic
		// detached HEAD
		try {
			const sha = run("git rev-parse --short HEAD");
			return sha ? `detached-${sha}` : "default";
		} catch {
			return "default";
		}
	} catch {
		return "default";
	}
}

/** Best-effort extension directory (used to locate the bundled skill). */
const EXT_DIR: string = (() => {
	try {
		if (import.meta?.url) return dirname(fileURLToPath(import.meta.url));
	} catch {
		// fall through
	}
	return join(homedir(), ".pi", "agent", "extensions", "pi-handoff");
})();

// ---------------------------------------------------------------------------

export default function piHandoff(pi: ExtensionAPI) {
	let store: HandoffStore | null = null;
	let collector: Collector | null = null;
	let injector: Injector | null = null;
	/** Git branch the current store is scoped to ("" until session_start). */
	let currentBranch = "";

	// Refresh queue state — deliberately in-memory only. Persisted lock state
	// wedges the queue after a crash; every session starts fresh at idle.
	let busy = false;
	let inFlight: Promise<unknown> | null = null;
	let errors = 0;
	let lastModel: string | null = null;
	let clearOfferPending = false;
	/** AbortController for the currently-running drain; aborted on shutdown or a branch switch. */
	let activeAbort: AbortController | null = null;

	const debug = (msg: string) => {
		if (process.env.PI_HANDOFF_DEBUG) console.error(`[pi-handoff] ${msg}`);
	};

	const notify = (ctx: Ctx, msg: string, level: "info" | "warning" | "error" = "info") => {
		if (ctx.hasUI) ctx.ui.notify(msg, level);
	};

	const kb = (n: number) => (n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}k`);
	const fsSize = (path: string) => {
		try {
			return statSync(path).size;
		} catch {
			return 0;
		}
	};

	function status(ctx: Ctx, modelOverride?: { name?: string }): void {
		if (!ctx.hasUI || !store) return;
		const s = store;
		// Two visible states (plus off): ✓ Synced ↔ ↻ Syncing. A small not-yet-folded
		// buffer is the normal steady state under ✓ Synced — the next fold fires at
		// TURN_THRESHOLD turns or CHAR_THRESHOLD chars (→ ↻ Syncing), and repeated
		// fold failures surface as the trailing ·Nerr badge. pendingChars stays
		// internal (drives shouldAutoRefresh); exact counts live in `handoff status`.
		let state: string;
		if (!s.meta.enabled) state = "○ off";
		else if (busy) state = "↻ Syncing";
		else state = "✓ Synced";
		const err = errors > 0 ? ` · ${errors}err` : "";
		const branch = currentBranch || "default";
		const model = modelOverride?.name ?? ctx.model?.name ?? "no-model";
		ctx.ui.setStatus("pi-handoff", `[Handoff] ${model} ${state} branch:${branch}${err}`);
	}

	// ----------------------------------------------------- store adoption

	/** Create + init the store for (project root, branch), wire collector/injector, recompute pending. Returns the store. */
	function adoptStore(ctx: Ctx, branch: string): HandoffStore {
		const projectRoot = resolveProjectRoot(ctx.cwd);
		// One-time: a pre-repo-key store opened from this cwd carries forward to
		// the repo-root container rather than starting blank next to it.
		migrateProjectKey(ctx.cwd, projectRoot);
		const s = HandoffStore.forCwdAndBranch(projectRoot, branch);
		s.initSync();
		store = s;
		currentBranch = branch;
		// pending chars + turn count derived from durable cursors (survive restarts & branch switches)
		const since = s.readEventsSince(s.meta.lastRefreshedSeq);
		s.pendingChars = since.reduce((n, e) => n + (e.excerpts ?? []).reduce((m, x) => m + x.text.length, 0), 0);
		s.turnsSinceRefresh = since.filter((e) => e.type === "turn_end").length;
		collector = new Collector(s);
		injector = new Injector(s);
		status(ctx);
		debug(`adoptStore: branch=${branch} root=${s.root} events=${s.meta.nextSeq - 1} pending=${s.pendingChars}`);
		return s;
	}

	/** Claim this store as the live owner (on session start and branch switch). */
	function claimOwnership(sid: string): void {
		if (!store) return;
		store.meta.sessionId = sid;
		store.meta.pid = process.pid;
		store.meta.endedAt = ""; // we're the live owner now
		store.saveMetaSync();
	}

	/** Warn if a different live session is concurrently writing this same store. */
	function checkConcurrentWriter(ctx: Ctx, sid: string): void {
		if (!store) return;
		const prevSid = store.meta.sessionId;
		// A prior owner that ended gracefully (quit, /new, /resume, /fork, /reload,
		// or a branch switch) is a sequential handoff, NOT a concurrent writer.
		if (prevSid && sid && prevSid !== sid && !store.meta.endedAt) {
			const recent = Date.now() - Date.parse(store.meta.updatedAt || "1970-01-01") < 60_000;
			if (recent && isPidAlive(store.meta.pid)) {
				notify(ctx, "pi-handoff: another session updated this handoff <1m ago — concurrent writers share files, last writer wins", "warning");
			}
		}
	}

	// ------------------------------------------------------------- queue

	function modelCtx(ctx: Ctx) {
		return { model: ctx.model, modelRegistry: ctx.modelRegistry };
	}

	/** Serialize an arbitrary store op with the refresh queue. */
	async function runExclusive<T>(ctx: Ctx, fn: () => Promise<T>): Promise<T | null> {
		if (busy && inFlight) await inFlight.catch(() => {});
		if (busy) return null; // extremely unlikely; another op slipped in
		busy = true;
		status(ctx);
		try {
			return await fn();
		} finally {
			busy = false;
			status(ctx);
		}
	}

	function drain(ctx: Ctx, opts: { force?: boolean; anyPending?: boolean; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> | null {
		if (!store || !store.meta.enabled) return null;
		if (busy) return inFlight; // coalesce; pending work still tracked via pendingChars/turnsSinceRefresh
		const wanted = opts.force
			? store.pendingChars > 0 || !!opts.anyPending
			: shouldAutoRefresh(store.pendingChars, store.turnsSinceRefresh);
		if (!wanted) return null;

		// Pin the store: a mid-turn branch switch reassigns the outer `store` var,
		// but an in-flight drain must keep targeting the branch it started on.
		const s = store;
		const ac = new AbortController();
		activeAbort = ac;
		// An external caller (e.g. the handoff tool's flush) may supply its own
		// abort — wiring it in keeps a tool-initiated refresh interruptible when
		// the user cancels the turn.
		if (opts.signal) {
			if (opts.signal.aborted) ac.abort(opts.signal.reason);
			else opts.signal.addEventListener("abort", () => ac.abort(opts.signal!.reason), { once: true });
		}
		const p = runExclusive(ctx, async () => {
			do {
				try {
					const r = await runRefresh(s, modelCtx(ctx), opts.timeoutMs ?? REFRESH_TIMEOUT_MS, ac.signal);
					if (r?.modelSource) lastModel = r.modelSource;
					errors = 0; // success → clear any transient error count
				} catch (e) {
					// A shutdown/branch-switch abort is not an error — don't poison the counter.
					if (!ac.signal.aborted) {
						errors++;
						debug(`refresh failed: ${e instanceof Error ? e.message : e}`);
					}
					break; // events stay buffered; retried on next trigger
				}
			} while (!ac.signal.aborted && shouldAutoRefresh(s.pendingChars, s.turnsSinceRefresh));
		});
		inFlight = p.catch(() => {});
		void p.finally(() => {
			inFlight = null;
			if (activeAbort === ac) activeAbort = null;
		});
		return p;
	}

	// ------------------------------------------------------------- skill

	pi.on("resources_discover", async () => ({ skillPaths: [join(EXT_DIR, "skills")] }));

	// ------------------------------------------------------------- lifecycle

	pi.on("session_start", async (event, ctx) => {
		try {
			const sid = ctx.sessionManager.getSessionId?.() ?? "";
			const s = adoptStore(ctx, detectBranch(ctx.cwd));
			checkConcurrentWriter(ctx, sid);
			claimOwnership(sid);
			clearOfferPending = event.reason === "resume" && HandoffStore.hasRealContent(s.readHandoff());
			debug(`session_start: branch=${currentBranch} reason=${event.reason} root=${s.root}`);
		} catch (e) {
			debug(`session_start failed: ${e}`);
		}
	});

	pi.on("message_end", async (event) => {
		try {
			collector?.onMessageEnd(event.message as any);
		} catch (e) {
			debug(String(e));
		}
	});

	pi.on("tool_execution_start", async (event) => {
		try {
			collector?.onToolStart(event.toolCallId, event.toolName, event.args);
		} catch (e) {
			debug(String(e));
		}
	});

	pi.on("tool_execution_end", async (event) => {
		try {
			collector?.onToolEnd(event.toolCallId, event.toolName, event.isError);
		} catch (e) {
			debug(String(e));
		}
	});

	// Model changed mid-session via /model, Ctrl+P, or session restore — re-render
	// the bar so the model name stays current. ctx.model may not yet reflect the new
	// model at event time, so prefer event.model (falls back to ctx.model if absent).
	pi.on("model_select", async (event, ctx) => {
		try {
			status(ctx, event.model);
		} catch (e) {
			debug(String(e));
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		try {
			if (!collector || !store?.meta.enabled) return;
			collector.onTurnEnd(event);
			status(ctx);
		} catch (e) {
			debug(String(e));
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		try {
			if (!store?.meta.enabled) return;
			drain(ctx)?.catch(() => {}); // never block the agent loop
		} catch (e) {
			debug(String(e));
		}
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		// flush so no work lives only in soon-to-be-compacted turns
		await drain(ctx, { force: true })?.catch(() => {});
	});

	pi.on("session_compact", async () => {
		try {
			if (!store?.meta.enabled) return;
			store.appendEvent({ sessionId: store.meta.sessionId, turn: -1, type: "compact" });
		} catch (e) {
			debug(String(e));
		}
	});

	pi.on("session_shutdown", async () => {
		try {
			// Mark this session as ended gracefully so the next session_start (a
			// fast restart, or an in-process /new, /resume, /fork, /reload) doesn't
			// mistake itself for a concurrent writer. Best-effort: a crash skips
			// this, but then the dead-pid check on the next start covers it.
			if (store) {
				store.meta.endedAt = new Date().toISOString();
				store.saveMetaSync();
			}
			// Events are durable in events.jsonl (appended synchronously by the
			// collector on turn_end) and pendingChars is recomputed from
			// lastRefreshedSeq on the next session_start. Not flushing at shutdown
			// loses nothing — the next session picks up the un-folded events and
			// refreshes them. Blocking exit on a full LLM refresh is what made
			// quitting slow, so abort anything in flight and return promptly.
			// writeHandoff is atomic (temp+rename), so aborting mid-write cannot
			// corrupt handoff.md; lastRefreshedSeq only advances on success.
			if (activeAbort) activeAbort.abort(new Error("pi-handoff: shutdown"));
			if (inFlight) await Promise.race([inFlight, sleep(SHUTDOWN_GRACE_MS)]);
			// Drop the event log for a clean slate next session if it grew large.
			// Below EVENTS_EXIT_CLEAR_LINES (default 500) it's kept so recent snapshot
			// history survives across restarts; at/above the threshold we wipe it —
			// an accepted tradeoff that also discards older snapshots, so recovering
			// a prior handoff returns nothing after such a restart.
			if (store) store.clearEventsOnShutdownIfLarge();
		} catch {
			// never throw while shutting down
		}
	});

	function sleep(ms: number): Promise<void> {
		// unref'd: a losing race must not hold the event loop open and delay exit
		return new Promise((r) => {
			setTimeout(r, ms).unref?.();
		});
	}

	// ------------------------------------------------------------- goal-change offer

	const STOP = new Set([
		"that", "this", "with", "from", "have", "what", "when", "then", "than", "into", "your", "yours",
		"about", "would", "could", "should", "there", "their", "they", "them", "will", "shall", "just",
		"continue", "please", "keep", "going", "work", "working", "session", "previous", "next", "also",
	]);

	function words(text: string): Set<string> {
		const out = new Set<string>();
		for (const w of text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []) {
			if (!STOP.has(w)) out.add(w);
		}
		return out;
	}

	function looksRelated(a: string, b: string): boolean {
		const wa = words(a);
		const wb = words(b);
		if (wa.size === 0 || wb.size === 0) return true; // insufficient signal → assume related
		let inter = 0;
		for (const w of wa) if (wb.has(w)) inter++;
		const union = wa.size + wb.size - inter;
		return inter / union >= 0.12;
	}

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			// Re-detect the git branch each turn (pi emits no event on `git checkout`);
			// if it changed, swap to that branch's store before this turn is collected.
			// before_agent_start fires before the user message_end, so the new
			// collector captures this turn's prompt (nothing buffered is lost).
			if (store?.meta.enabled) {
				const b = detectBranch(ctx.cwd);
				if (b !== currentBranch) {
					const sid = ctx.sessionManager.getSessionId?.() ?? "";
					// Abandon any in-flight refresh on the old branch — its events are
					// durable in events.jsonl and fold in next time that branch loads.
					if (activeAbort) activeAbort.abort(new Error("pi-handoff: branch switch"));
					if (inFlight) await inFlight.catch(() => {});
					if (store) { store.meta.endedAt = new Date().toISOString(); store.saveMetaSync(); }
					const s = adoptStore(ctx, b);
					// Order matters: the check reads the PREVIOUS owner's meta fields;
					// claimOwnership overwrites sessionId/pid/endedAt with our own, which
					// would make the check compare us against ourselves and never warn.
					checkConcurrentWriter(ctx, sid);
					claimOwnership(sid);
					// Re-arm the goal-change offer against the new branch's handoff.
					clearOfferPending = HandoffStore.hasRealContent(s.readHandoff());
					debug(`branch switch -> ${b} (store ${s.root})`);
				}
			}

			if (!clearOfferPending || !store?.meta.enabled || !ctx.hasUI) return;
			clearOfferPending = false; // offer at most once per branch adoption
			const prompt = event.prompt ?? "";
			if (prompt.length < 80) return; // short prompts carry no task signal
			const goal = extractSection(store.readHandoff(), "Current Goal");
			if (!goal || looksRelated(goal, prompt)) return;
			const yes = await ctx.ui.confirm(
				"pi-handoff — different task detected",
				`Previous task: “${truncateInMiddle(goal, 120)}”\n\nStart a fresh handoff for this new task? The current one is kept in events.jsonl and your pinned rules are unaffected.`,
			);
			if (yes) clearHandoff();
		} catch (e) {
			debug(String(e));
		}
	});

	function extractSection(doc: string, name: string): string {
		const m = doc.match(new RegExp(`^# ${name}\\s*\\n([\\s\\S]*?)(?=^# |$(?![\\s\\S]))`, "m"));
		return (m?.[1] ?? "").replace(/^-+$/gm, "").trim();
	}

	function truncateInMiddle(text: string, max: number): string {
		const flat = text.replace(/\s+/g, " ").trim();
		if (flat.length <= max) return flat;
		const half = Math.floor((max - 1) / 2);
		return flat.slice(0, half) + "…" + flat.slice(flat.length - half);
	}

	function clearHandoff(): void {
		if (!store) return;
		store.appendEvent({ sessionId: store.meta.sessionId, turn: -1, type: "clear" });
		store.clearTaskState();
		store.markRefreshed(store.meta.nextSeq - 1); // pre-clear events are not re-merged
		store.saveMetaSync();
	}

	// ------------------------------------------------------------- injection

	pi.on("context", async (event) => {
		try {
			if (!injector || !store?.meta.enabled) return undefined;
			const msg = injector.buildMessage();
			if (!msg) return undefined;
			return { messages: [msg as never, ...event.messages] };
		} catch {
			return undefined; // injection must never break a request
		}
	});

	// ------------------------------------------------------------- tool

	/**
	 * The agent's write path into the shared project memory — the port of
	 * opencode-handoff v0.6.1's `handoff` tool, so both agents curate the same
	 * project.md. The description doubles as the pinning policy: it is the only
	 * guidance the agent gets about WHAT deserves a pin, so it must stay strict
	 * (durable, branch-independent, costly to rediscover — otherwise the file
	 * grows into noise that every future session pays to read).
	 *
	 * Deliberately narrower than the slash command: no clear/on/off. Wiping the
	 * current task's handoff or disabling collection is the user's call; the
	 * agent may curate memory, never silently destroy it. Pins themselves are
	 * safe to delegate because every guardrail is program-side: dedupe makes
	 * re-pinning a no-op, ambiguous unpin removes nothing, and all writes are
	 * atomic.
	 */
	pi.registerTool(
		defineTool({
			name: "handoff",
			label: "Handoff",
			description:
				"Inspect and curate this project's persistent memory (handoff.md per branch + project.md standing rules shared by every branch and by other agents). " +
				"Actions: 'status' (stats, store path, current pins), 'flush' (force a handoff.md refresh now — costs one background model call; rarely needed, e.g. before a risky operation), 'pin' (record a standing project rule — requires 'note'), 'unpin' (remove one — 'note' is a substring match; an ambiguous match removes nothing and lists the candidates). " +
				"WHEN TO PIN, on your own initiative: you are encouraged to pin without being asked when you learn something GENERAL about this project — true on every branch, still true after the current task, and costly to rediscover. Good pins: the actual command to run tests or the dev server when it is not obvious; where a shared library/component lives; deploy and release rules; hard prohibitions ('never edit src/generated/'); a stated user preference about how to work in this repo. " +
				"Do NOT pin: anything about the current task or its progress (the handoff records that automatically), anything specific to one branch, one-off decisions, transient state, anything already stated in AGENTS.md/CLAUDE.md/README (it is already in your context), or secrets. " +
				"Pins are permanent, apply to every branch, and are never rewritten by the summarizer — so prefer one durable sentence over a running commentary, and when in doubt, do not pin. Re-pinning an existing note is a no-op.",
			promptSnippet: "Inspect and curate persistent project memory (pins shared across branches)",
			promptGuidelines: [
				"When you learn a durable project fact — true on every branch and worth knowing after the current task — record it with the handoff tool (action: 'pin'). Do not pin task progress; the handoff records that automatically.",
			],
			parameters: Type.Object({
				action: StringEnum(["status", "flush", "pin", "unpin"], {
					description: "status = inspect; flush = merge pending events into handoff.md now; pin = record a standing project rule; unpin = remove one by substring",
				}),
				note: Type.Optional(
					Type.String({
						description: "For action=pin: the standing project rule to record (applies on every branch). For action=unpin: a substring identifying which pin to remove.",
					}),
				),
			}),
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
				const txt = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
				if (!store) return txt("pi-handoff: not initialized (no session yet)");
				const s = store;
				switch (params.action) {
					case "status":
						return txt(statusText(ctx.cwd) ?? "pi-handoff: not initialized");
					case "pin": {
						if (!params.note?.trim()) return txt("handoff: action=pin requires a 'note'");
						if (!s.appendPinned(params.note)) return txt(`pi-handoff: already pinned — no change. Current pins:\n${s.pinnedNotes().join("\n") || "(none)"}`);
						s.appendEvent({ sessionId: s.meta.sessionId, turn: -1, type: "pin", note: params.note });
						return txt(`Pinned to ${s.projectDocPath} — applies on every branch of this project and is visible to other agents sharing this store. It appears in context from the next request on.`);
					}
					case "unpin": {
						if (!params.note?.trim()) return txt("handoff: action=unpin requires a 'note' (a substring of the pin to remove)");
						const { removed, candidates } = s.removePinned(params.note);
						if (removed) return txt(`Unpinned ${removed}`);
						if (candidates.length > 1)
							return txt(`"${params.note}" matches ${candidates.length} pins — nothing removed (ambiguous matches never delete). Be more specific:\n${candidates.join("\n")}`);
						return txt(`No pin matches "${params.note}". Current pins:\n${s.pinnedNotes().join("\n") || "(none)"}`);
					}
					case "flush": {
						const wasBusy = busy;
						const errsBefore = errors;
						const p = drain(ctx, { force: true, anyPending: true, signal });
						if (!p) return txt(s.meta.enabled ? "pi-handoff: nothing to flush" : "pi-handoff: disabled — no collection, refresh, or injection");
						await p.catch(() => {});
						if (signal?.aborted) return txt("pi-handoff: flush aborted — buffered events are kept and retried automatically.");
						if (errors > errsBefore)
							return txt("pi-handoff: summarizer call failed — buffered events are kept and will be retried automatically.");
						return txt(`${wasBusy ? "A refresh was already in flight; awaited it. " : ""}handoff.md is up to date (${kb(fsSize(s.handoffPath))}).`);
					}
					default:
						// StringEnum widens to string in the type system; the schema
						// constrains runtime values, so this is unreachable.
						return txt(`handoff: unknown action "${params.action}" — try status|flush|pin|unpin`);
				}
			},
		}),
	);

	// ------------------------------------------------------------- commands

	const SUBCOMMANDS = [
		["status", "Show handoff statistics"],
		["flush", "Force a handoff.md refresh now"],
		["pin", "Record a standing project rule (applies on every branch)"],
		["unpin", "Remove a pinned rule by substring match"],
		["distill", "Scan every branch's handoff and pin the standing facts"],
		["clear", "Start a fresh handoff for a new task (pins are kept)"],
		["on", "Enable pi-handoff"],
		["off", "Disable pi-handoff"],
	] as const;

	pi.registerCommand("pi-handoff", {
		description: "pi-handoff: self-maintaining handoff.md (status|flush|pin|unpin|distill|clear|on|off)",
		getArgumentCompletions: (prefix: string) =>
			SUBCOMMANDS.filter(([name]) => name.startsWith(prefix)).map(([value, label]) => ({ value, label })),
		handler: async (args, ctx: ExtensionCommandContext) => {
			const [sub = "status", ...rest] = args.trim().split(/\s+/);
			const text = rest.join(" ");
			try {
				switch (sub) {
					case "status":
						return cmdStatus(ctx);
					case "flush":
						return await cmdFlush(ctx);
					case "pin":
						return cmdPin(ctx, text);
					case "unpin":
						return cmdUnpin(ctx, text);
					case "distill":
						return await cmdDistill(ctx);
					case "clear":
						return await cmdReset(ctx);
					case "on":
						return cmdToggle(ctx, true);
					case "off":
						return cmdToggle(ctx, false);
					default:
						notify(ctx, `pi-handoff: unknown subcommand "${sub}" — try status|flush|pin|unpin|clear|on|off`, "error");
				}
			} catch (e) {
				notify(ctx, `pi-handoff ${sub} failed: ${e instanceof Error ? e.message : e}`, "error");
			}
		},
	});

	/** Same status text for the /pi-handoff command and the agent-facing handoff tool. */
	function statusText(cwd: string): string | null {
		if (!store) return null;
		const m = store.meta;
		return [
			`pi-handoff — store: ${store.root}`,
			`  branch: ${currentBranch}`,
			`  project: ${m.projectPath || cwd}`,
			`  enabled: ${m.enabled}   queue: ${busy ? "running" : "idle"}`,
			`  events: ${m.nextSeq - 1} · pending ${kb(store.pendingChars)} · ${store.turnsSinceRefresh} turns (fold ≥${TURN_THRESHOLD} turns or ≥${kb(CHAR_THRESHOLD)} chars)`,
			`  handoff.md: ${kb(fsSize(store.handoffPath))} (refreshed at seq ${m.lastRefreshedSeq})`,
			`  pinned: ${store.pinnedNotes().length} project-level note(s) in ${store.projectDocPath}`,
			...store.pinnedNotes().map((n) => `    ${n}`),
			`  summarizer: ${m.summarizerUsage.calls} calls, ${m.summarizerUsage.totalTokens} tokens${lastModel ? `, last via ${lastModel}` : ""}`,
		].join("\n");
	}

	function cmdStatus(ctx: Ctx): void {
		const text = statusText(ctx.cwd);
		notify(ctx, text ?? "pi-handoff: not initialized", text ? "info" : "warning");
	}

	async function cmdFlush(ctx: ExtensionCommandContext): Promise<void> {
		if (!store) return;
		await ctx.waitForIdle();
		const done = drain(ctx, { force: true, anyPending: true });
		if (!done) return notify(ctx, "pi-handoff: nothing to flush");
		await done;
		notify(ctx, `pi-handoff: handoff.md refreshed · ${kb(fsSize(store.handoffPath))}`);
	}

	function cmdPin(ctx: Ctx, text: string): void {
		if (!store) return;
		if (!text) return notify(ctx, "usage: /pi-handoff pin <note>", "warning");
		if (!store.appendPinned(text)) return notify(ctx, "pi-handoff: already pinned — no change");
		store.appendEvent({ sessionId: store.meta.sessionId, turn: -1, type: "pin", note: text });
		notify(ctx, `pi-handoff: pinned to ${store.projectDocPath} — applies on every branch of this project`);
	}

	function cmdUnpin(ctx: Ctx, text: string): void {
		if (!store) return;
		if (!text) return notify(ctx, "usage: /pi-handoff unpin <substring of the pin>", "warning");
		const { removed, candidates } = store.removePinned(text);
		if (removed) return notify(ctx, `pi-handoff: unpinned ${removed}`);
		if (candidates.length > 1)
			return notify(ctx, `pi-handoff: "${text}" matches ${candidates.length} pins — be more specific:\n${candidates.join("\n")}`, "warning");
		notify(ctx, `pi-handoff: no pin matches "${text}". Current pins:\n${store.pinnedNotes().join("\n") || "(none)"}`, "warning");
	}

	/**
	 * Cross-branch aggregation, the one job the per-branch background refresh
	 * can't do: read every branch's handoff of this project, draft candidate
	 * standing facts, and let the USER confirm which become pins. Nothing is
	 * written without an explicit yes — the trusted tier stays human-gated even
	 * though the extraction itself is automatic.
	 */
	async function cmdDistill(ctx: ExtensionCommandContext): Promise<void> {
		if (!store) return;
		await ctx.waitForIdle();
		await runExclusive(ctx, async () => {
			if (!store) return;
			const docs = listBranchDocs(resolveProjectRoot(ctx.cwd));
			if (docs.length === 0) return notify(ctx, "pi-handoff: no branch handoffs with content yet — nothing to distill", "warning");
			const pins = store.pinnedNotes();
			let res;
			try {
				res = await runDistill(docs, pins, modelCtx(ctx), REFRESH_TIMEOUT_MS);
			} catch (e) {
				return notify(ctx, `pi-handoff distill failed: ${e instanceof Error ? e.message : e}`, "error");
			}
			if (res.candidates.length === 0)
				return notify(ctx, `pi-handoff: ${docs.length} branch handoff(s) scanned via ${res.modelSource} — no standing facts beyond the ${pins.length} existing pin(s)`);
			if (!ctx.hasUI) {
				return notify(ctx, `pi-handoff distill candidates (nothing pinned without review):\n${res.candidates.map((c) => `- ${c}`).join("\n")}`);
			}
			let added = 0;
			let deduped = 0;
			for (let i = 0; i < res.candidates.length; i++) {
				const c = res.candidates[i];
				const yes = await ctx.ui.confirm(
					`pi-handoff distill — candidate ${i + 1} of ${res.candidates.length}`,
					`${c}\n\nPin this as a standing rule? It will apply on every branch and is never rewritten by the summarizer.`,
				);
				if (!yes) continue;
				if (store.appendPinned(c)) {
					store.appendEvent({ sessionId: store.meta.sessionId, turn: -1, type: "pin", note: c });
					added++;
				} else {
					deduped++;
				}
			}
			notify(
				ctx,
				`pi-handoff: distill done — ${added} pinned, ${deduped} already pinned, ${res.candidates.length - added - deduped} skipped (${docs.length} branch handoffs scanned via ${res.modelSource})`,
			);
		});
	}

	async function cmdReset(ctx: ExtensionCommandContext): Promise<void> {
		if (!store) return;
		if (ctx.hasUI) {
			const yes = await ctx.ui.confirm(
				"pi-handoff — clear",
				"Start a FRESH handoff.md for a new task?\nYour pinned rules are unaffected and the current document stays recoverable in events.jsonl.",
			);
			if (!yes) return;
		}
		await ctx.waitForIdle();
		await runExclusive(ctx, async () => clearHandoff());
		notify(ctx, "pi-handoff: clear. Fresh handoff.md ready for the next task.");
	}

	function cmdToggle(ctx: Ctx, enabled: boolean): void {
		if (!store) return;
		store.meta.enabled = enabled;
		store.saveMetaSync();
		status(ctx);
		notify(ctx, enabled ? "pi-handoff: enabled" : "pi-handoff: disabled (no collection, refresh, or injection)");
	}
}
