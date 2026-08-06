/**
 * pi-handoff — a self-maintaining handoff.md per working directory, stored
 * outside the project.
 *
 * Each working directory gets its own store under ~/.pi/agent/pi-handoff/, named
 * after the directory's absolute path (see resolveStoreRoot); nothing is
 * written into the repository itself.
 *
 *   events.jsonl   append-only log, written by the collector (no LLM)
 *   handoff.md     the document, refreshed in the background as work happens
 *
 * Recall: every LLM call gets the current document injected via the `context`
 * event (non-destructive, never persisted into the session).
 *
 * Commands: /pi-handoff status|flush|pin|reset|on|off
 * Env:      PI_HANDOFF_MODEL=provider/id  PI_HANDOFF_THRESHOLD_CHARS=2000
 *           PI_HANDOFF_DIR=<dir>  PI_HANDOFF_DEBUG=1
 */

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Collector } from "./collector";
import { Injector } from "./injector";
import { HandoffStore } from "./store";
import { runRefresh } from "./summarizer";

const THRESHOLD = Math.max(200, Number(process.env.PI_HANDOFF_THRESHOLD_CHARS ?? 2_000) || 2_000);
const REFRESH_TIMEOUT_MS = 120_000;
/** Max wait for an in-flight refresh to settle on shutdown (abort fires first; this is a backstop). */
const SHUTDOWN_GRACE_MS = 2_000;

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

	// Refresh queue state — deliberately in-memory only. Persisted lock state
	// wedges the queue after a crash; every session starts fresh at idle.
	let busy = false;
	let dirty = false;
	let inFlight: Promise<unknown> | null = null;
	let errors = 0;
	let lastModel: string | null = null;
	let resetOfferPending = false;
	/** AbortController for the currently-running drain; aborted on shutdown so quit is prompt. */
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

	function status(ctx: Ctx): void {
		if (!ctx.hasUI || !store) return;
		const s = store;
		const state = busy ? "↻" : s.meta.enabled ? "●" : "○";
		const err = errors > 0 ? ` · ${errors}err` : "";
		const model = lastModel ? ` · ${lastModel.split("/").pop()}` : "";
		ctx.ui.setStatus(
			"pi-handoff",
			`handoff ${state} ev ${s.meta.nextSeq - 1} · ${kb(fsSize(s.handoffPath))} · pend ${kb(s.pendingChars)}${model}${err}`,
		);
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

	function drain(ctx: Ctx, opts: { force?: boolean; anyPending?: boolean; timeoutMs?: number } = {}): Promise<unknown> | null {
		if (!store || !store.meta.enabled) return null;
		if (busy) return inFlight; // coalesce; pending work still tracked via pendingChars
		const pending = store.pendingChars;
		const wanted = opts.force ? pending > 0 || !!opts.anyPending : dirty || pending >= THRESHOLD;
		if (!wanted) return null;
		dirty = false;

		const ac = new AbortController();
		activeAbort = ac;
		const p = runExclusive(ctx, async () => {
			do {
				try {
					const r = await runRefresh(store!, modelCtx(ctx), opts.timeoutMs ?? REFRESH_TIMEOUT_MS, ac.signal);
					if (r?.modelSource) lastModel = r.modelSource;
					errors = 0; // success → clear any transient error count
				} catch (e) {
					// A shutdown abort is not an error — don't poison the error counter.
					if (!ac.signal.aborted) {
						errors++;
						debug(`refresh failed: ${e instanceof Error ? e.message : e}`);
					}
					break; // events stay buffered; retried on next trigger
				}
			} while (store!.pendingChars >= THRESHOLD && !dirty && !ac.signal.aborted);
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
			store = HandoffStore.forCwd(ctx.cwd);
			store.initSync();

			const sid = ctx.sessionManager.getSessionId?.() ?? "";
			const prevSid = store.meta.sessionId;
			// A prior owner that ended gracefully (quit, /new, /resume, /fork, /reload)
			// is a sequential handoff, NOT a concurrent writer — never warn for it.
			// Only warn when the prior owner never shut down AND its process is still
			// alive, i.e. two sessions are genuinely writing the same files at once.
			if (prevSid && sid && prevSid !== sid && !store.meta.endedAt) {
				const recent = Date.now() - Date.parse(store.meta.updatedAt || "1970-01-01") < 60_000;
				if (recent && isPidAlive(store.meta.pid)) {
					notify(ctx, "pi-handoff: another session updated this handoff <1m ago — concurrent writers share files, last writer wins", "warning");
				}
			}
			// pending chars derived from durable cursors (survives restarts)
			store.pendingChars = store
				.readEventsSince(store.meta.lastRefreshedSeq)
				.reduce((n, e) => n + (e.excerpts ?? []).reduce((m, x) => m + x.text.length, 0), 0);
			store.meta.sessionId = sid;
			store.meta.pid = process.pid;
			store.meta.endedAt = ""; // we're the live owner now
			store.saveMetaSync();

			collector = new Collector(store);
			injector = new Injector(store);
			resetOfferPending = event.reason === "resume" && HandoffStore.hasRealContent(store.readHandoff());

			status(ctx);
			debug(`session_start: root=${store.root} events=${store.meta.nextSeq - 1} pending=${store.pendingChars}`);
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
			if (!resetOfferPending || !store?.meta.enabled || !ctx.hasUI) return;
			resetOfferPending = false; // offer at most once per session
			const prompt = event.prompt ?? "";
			if (prompt.length < 80) return; // short prompts carry no task signal
			const goal = extractSection(store.readHandoff(), "Current Goal");
			if (!goal || looksRelated(goal, prompt)) return;
			const yes = await ctx.ui.confirm(
				"pi-handoff — different task detected",
				`Previous task: “${truncateInMiddle(goal, 120)}”\n\nStart a fresh handoff for this new task? The current one is kept in events.jsonl and the Pinned section carries over.`,
			);
			if (yes) resetHandoff();
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

	function resetHandoff(): void {
		if (!store) return;
		store.appendEvent({ sessionId: store.meta.sessionId, turn: -1, type: "reset" });
		store.resetKeepingPinned();
		store.markRefreshed(store.meta.nextSeq - 1); // pre-reset events are not re-merged
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

	// ------------------------------------------------------------- commands

	const SUBCOMMANDS = [
		["status", "Show handoff statistics"],
		["flush", "Force a handoff.md refresh now"],
		["pin", "Add a durable note the summarizer never rewrites"],
		["reset", "Start a fresh handoff for a new task (keeps Pinned)"],
		["on", "Enable pi-handoff"],
		["off", "Disable pi-handoff"],
	] as const;

	pi.registerCommand("pi-handoff", {
		description: "pi-handoff: self-maintaining handoff.md (status|flush|pin|reset|on|off)",
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
					case "reset":
						return await cmdReset(ctx);
					case "on":
						return cmdToggle(ctx, true);
					case "off":
						return cmdToggle(ctx, false);
					default:
						notify(ctx, `pi-handoff: unknown subcommand "${sub}" — try status|flush|pin|reset|on|off`, "error");
				}
			} catch (e) {
				notify(ctx, `pi-handoff ${sub} failed: ${e instanceof Error ? e.message : e}`, "error");
			}
		},
	});

	function cmdStatus(ctx: Ctx): void {
		if (!store) return notify(ctx, "pi-handoff: not initialized", "warning");
		const m = store.meta;
		notify(
			ctx,
			[
				`pi-handoff — store: ${store.root}`,
				`  project: ${m.projectPath || ctx.cwd}`,
				`  enabled: ${m.enabled}   queue: ${busy ? "running" : "idle"}`,
				`  events: ${m.nextSeq - 1} · pending ${kb(store.pendingChars)} (threshold ${kb(THRESHOLD)})`,
				`  handoff.md: ${kb(fsSize(store.handoffPath))} (refreshed at seq ${m.lastRefreshedSeq})`,
				`  summarizer: ${m.summarizerUsage.calls} calls, ${m.summarizerUsage.totalTokens} tokens${lastModel ? `, last via ${lastModel}` : ""}`,
			].join("\n"),
		);
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
		store.appendPinned(text);
		store.appendEvent({ sessionId: store.meta.sessionId, turn: -1, type: "pin", note: text });
		notify(ctx, "pi-handoff: pinned (summarizer will preserve it)");
	}

	async function cmdReset(ctx: ExtensionCommandContext): Promise<void> {
		if (!store) return;
		if (ctx.hasUI) {
			const yes = await ctx.ui.confirm(
				"pi-handoff — reset",
				"Start a FRESH handoff.md for a new task?\nThe Pinned section is kept and the current document stays recoverable in events.jsonl.",
			);
			if (!yes) return;
		}
		await ctx.waitForIdle();
		await runExclusive(ctx, async () => resetHandoff());
		notify(ctx, "pi-handoff: reset. Fresh handoff.md ready for the next task.");
	}

	function cmdToggle(ctx: Ctx, enabled: boolean): void {
		if (!store) return;
		store.meta.enabled = enabled;
		store.saveMetaSync();
		status(ctx);
		notify(ctx, enabled ? "pi-handoff: enabled" : "pi-handoff: disabled (no collection, refresh, or injection)");
	}
}
