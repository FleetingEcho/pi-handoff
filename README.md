# pi-handoff

Every working directory — and each git branch in it — gets a `handoff.md` that keeps itself up to date.

You never write it, and you never have to remember to update it. As you work, the extension records what happened and periodically asks a model to fold that into a short document: what the goal is, what's done, what was decided, which files matter, what's next. On your next session it is injected into the agent's context automatically — so `pi --resume` (or a brand-new session, or a different agent entirely) starts already knowing where you left off.

No "let me catch you up." No re-explaining the task. No `handoff.md` cluttering your repo.

## Install

Requires pi ≥ 0.83.

```bash
pi install git:github.com/FleetingEcho/pi-handoff  # tracks main (recommended — auto-reminds on updates)
```

Start pi and run `/pi-handoff`. You should see a status readout and a `handoff ●` indicator in the status bar. That's the whole setup — there is nothing to configure.

<details>
<summary>Other install options</summary>

```bash
pi install git:github.com/FleetingEcho/pi-handoff             # track the default branch (auto-reminds on updates)
pi install git:github.com/FleetingEcho/pi-handoff@v0.5.2       # pin to a specific tag (reproducible; manual upgrades only)
pi install -l git:github.com/FleetingEcho/pi-handoff   # this project only (writes .pi/settings.json, commit it to share with teammates)
pi -e git:github.com/FleetingEcho/pi-handoff                  # try it for one run, install nothing
pi list                                                       # what's installed
pi remove git:github.com/FleetingEcho/pi-handoff
```

Pinned git refs are **not** advanced by `pi update --extensions` — re-run `pi install` with the new tag to upgrade. The clone lands in `~/.pi/agent/git/gitlab.fafmgui.corp.fortinet.com` (or `.pi/git/...` for `-l`).

SSH remotes work too and use your `~/.ssh/config`:
`pi install git:github.com/FleetingEcho/pi-handoff`
</details>

### Updating

pi checks git-sourced extensions at startup (`git ls-remote`) and shows a **Package Updates Available** banner when the remote is ahead of your checkout — run `pi update --extensions`, then **restart pi** to load the new code (extensions load at startup, not live). This check covers the default unpinned install (tracks `main`); a pinned-tag install is skipped by it, so to upgrade one, re-run `pi install git:…@<new-tag>`, then restart. (`PI_OFFLINE=1` disables the check entirely.)

## Using it

### Just work

Open pi in a project and do whatever you were going to do. A background refresh folds recent turns into the document roughly every 3 turns — or sooner if a lot of new material piles up. It runs on your active model, never blocks you, and never interrupts.

The status bar tells you what's going on:

```
[Handoff] sonnet-4 ✓ Synced branch:main
          │        │
          │        └─ state: ✓ Synced = document current (small not-yet-folded buffer is normal) · ↻ Syncing = refreshing · ○ off
          └────────── active model — then state — then branch:<git branch> (non-git → "branch:default")

A ` · N err` suffix means the last N background refresh attempts failed (e.g. model error/timeout); it clears on the next successful fold. A large backlog can't hide under ✓ Synced — it triggers ↻ Syncing (and repeated failures surface as ·N err).
```

### Come back later

```bash
pi --resume     # or just `pi` — a fresh session works the same
```

The document is injected before your first message, so you can open with "keep going" or "what's left?" and the agent already has the context. Ask it to summarize where things stand and you'll see it reading from the handoff rather than guessing.

### Pin things that must never be forgotten

The summarizer rewrites the document freely — that's how it stays short. Anything you want protected from that goes in the **Pinned** section, which is program-managed and never touched by the model:

```
/pi-handoff pin Deploys go through ops/deploy.sh, never `make release`
/pi-handoff pin The staging DB is read-only; ask before any migration
```

Pinned notes survive every refresh and every reset. Use them for the standing facts you're tired of repeating.

### Starting a new task

When you move to something unrelated, the accumulated state is noise:

```
/pi-handoff reset
```

Fresh document, pinned notes kept, and the old version stays recoverable in the event log. If you resume with a prompt that clearly doesn't match the recorded goal, pi-handoff notices and offers this once — it never resets on its own.

### Read or edit it yourself

It's plain Markdown on your disk. `/pi-handoff status` prints the path:

```bash
/pi-handoff status
$EDITOR ~/.agent/agent-handoff/-home-zteng-work-Tools-TanWords/main/handoff.md   # path includes the current branch
```

Edit it freely — corrections you make are respected by the next refresh, which merges into whatever is currently on disk. (It's a merge, not an append, so the model may still rephrase or drop what it considers finished. Pin anything that must stick.)

### When you want it updated *right now*

```
/pi-handoff flush
```

Useful before closing a laptop, before a risky operation, or when you want the document current before handing the machine to someone else. Normally you don't need it — refreshes also run before context compaction, and buffered events fold at the start of the next session if you quit.

### Turning it off

```
/pi-handoff off     # stops collecting, refreshing, and injecting for this session
/pi-handoff on
```

## What the document looks like

Seven fixed sections, terse bullets, references to files rather than copies of them:

```markdown
# Current Goal
Move the memory store to ~/.pi/agent/pi-handoff and cut the layout to 3 files.

# Progress
- store.ts rewritten: HandoffStore, path-based slug, snapshots as events
- MEMORY.md and the distill/promote commands removed
- typecheck clean; lifecycle + trimming smoke-tested

# Decisions
- Directory name = absolute path with `/` → `-`; no hash needed, collisions impossible
- Old doc versions live in events.jsonl as `snapshot` records, not loose files
- Event log trims by BYTES (a line-count trim silently no-ops on large records)

# Constraints
- Never write anything into the user's project directory
- A pending refresh must never lose its input events

# Open Questions
- Rename the repo folder + GitHub remote from pi-mem?

# Active Files
- store.ts — persistence, slug, trimming
- summarizer.ts — the refresh LLM call
- index.ts — lifecycle wiring and commands

# Next Steps
- Commit; then `mv ~/work/Tools/pi-mem ~/work/Tools/pi-handoff`

---

# Pinned
- Deploys go through ops/deploy.sh, never `make release`
```

Budget is ~24 000 characters. If a refresh overshoots, the model gets one compression pass, then a hard truncation as a backstop.

## Where it lives

**Outside your project** — nothing is written into the repo, so there's nothing to gitignore and no risk of committing working state:

```
~/.agent/agent-handoff/-home-zteng-work-Tools-TanWords/<branch>/
├── handoff.md      the document
├── events.jsonl    append-only log; also holds previous versions
└── meta.json       cursors, telemetry, which project/branch this is
```

Three files per branch, no other subdirectories. The working directory becomes a container; **each git branch gets its own subdirectory** (and its own `handoff.md`), so switching branches switches handoffs — work on `feature/auth` and `fix/bug-12` stays separate. A non-git directory uses a single `default` branch. The branch is detected at session start and re-checked at the start of every turn, so a mid-session `git checkout` swaps to that branch's handoff immediately.

The container is named after the project's absolute path with `/` folded to `-`, so `~/work/a/api` and `~/work/b/api` can never collide, and you can tell at a glance which store belongs to what. Symlinked checkouts resolve to one store. Set `PI_HANDOFF_DIR` to keep the stores somewhere else. Stores from earlier versions under `~/.pi/agent/pi-handoff/`, and pre-v0.4.0 flat stores (with `handoff.md` directly in the container), are moved into the current branch's subdirectory automatically on first run.

**Recovering an earlier version** — old documents are `snapshot` records in the log rather than loose files:

```bash
STORE=~/.agent/agent-handoff/-home-zteng-work-Tools-TanWords/main
grep '"snapshot"' "$STORE/events.jsonl" | tail -1 | jq -r .doc     # the version before the last refresh
```

**Sharing one** — copy it into the repo deliberately:

```bash
cp "$STORE/handoff.md" docs/handoff.md && git add docs/handoff.md
```

For rules that should apply on *every* run rather than to the current task, use the project's `AGENTS.md` instead — every agent reads it every time.

## Commands

| Command | What it does |
|---|---|
| `/pi-handoff` or `/pi-handoff status` | Store path, event count, doc size, cursors, summarizer token usage |
| `/pi-handoff flush` | Refresh handoff.md right now |
| `/pi-handoff pin <note>` | Append a durable note the summarizer never rewrites |
| `/pi-handoff reset` | Fresh document for a new task (keeps Pinned; old version recoverable) |
| `/pi-handoff on` / `/pi-handoff off` | Toggle collection, refresh, and injection |

Also ships a `/skill:write-handoff` skill for when you want a handoff written by hand — tailored to a specific next session, rather than the rolling automatic one.

## Configuration (env)

| Var | Meaning |
|---|---|
| `PI_HANDOFF_MODEL` | `provider/model-id` for the summarizer. Default: your active session model — nothing to configure. Set this only if you want to pin a different (e.g. cheaper) model for refreshes. |
| `PI_HANDOFF_THRESHOLD_TURNS` | Auto-refresh every this many turns (default `3`). The primary cadence. Set `0` to rely on the character ceiling alone. |
| `PI_HANDOFF_THRESHOLD_CHARS` | Character ceiling that forces an early refresh even before the turn count is reached (default `8000`). A safety valve for heavy turns. |
| `PI_HANDOFF_DIR` | Root holding the per-project, per-branch stores (default `~/.agent/agent-handoff`). |
| `PI_HANDOFF_DEBUG` | `1` for stderr debug logs. |
| `PI_HANDOFF_EXIT_CLEAR_LINES` | On graceful shutdown, wipe `events.jsonl` if it has at least this many records (default `500`). Below it, the log is kept so recent snapshot history survives across restarts. `0` disables (the 4 MB in-place trim still bounds it). |

Example — pin the summarizer to a specific model (optional):

```bash
export PI_HANDOFF_MODEL=provider/model-id
```

## Troubleshooting

**The document isn't updating.** Check `/pi-handoff status`: if `pending` is below the threshold, nothing has accumulated yet — that's normal. If `enabled` is false, run `/pi-handoff on`. Otherwise run `PI_HANDOFF_DEBUG=1 pi` and watch stderr; refreshes use your active model, so auth issues are the same ones you'd hit chatting — if a refresh fails the events simply stay buffered until the next attempt.

**It didn't refresh when I quit.** By design it doesn't — quitting aborts any in-flight refresh (with a 2s backstop) so exit stays prompt. Normally nothing is lost: buffered events are durable in `events.jsonl` and merged at the start of the next session. One exception: if the log has grown to `PI_HANDOFF_EXIT_CLEAR_LINES` (default 500) records, it's wiped on exit for disk hygiene, so any not-yet-refreshed events would be lost in that case — set it to `0` to keep the log forever (the 4 MB in-place trim still bounds it).

**Two pi sessions in the same directory.** Sessions on the *same git branch* share one store and the last writer wins (with a startup warning only if the other session is still running). Sessions on *different branches* are fully isolated — that's the point of per-branch stores. Quitting and immediately starting a new session (or an in-process `/new`, `/resume`, `/fork`, `/reload`) is recognized as a sequential handoff and stays quiet.

**The document has stale or wrong information.** Edit the file directly, or `/pi-handoff reset` for a clean slate. To make a correction permanent, `/pi-handoff pin` it.

## How it works

```
git checkout ────► swap stores    branch detected at session start + each turn
turn_end ────────► events.jsonl   redacted excerpts, no LLM, deterministic
agent_settled ───► handoff.md     background merge once enough is pending
every LLM call ──► injected into context (non-destructive, never persisted)
```

Refreshes trigger on `agent_settled` — every `PI_HANDOFF_THRESHOLD_TURNS` turns (default 3), or sooner once `PI_HANDOFF_THRESHOLD_CHARS` (default 8000) of new material accumulates — plus before context compaction and on `/pi-handoff flush`. (Quitting does not flush; buffered events fold at the start of the next session.) A refresh never runs when there is nothing new to fold — opening pi and doing nothing makes no model call.

### Safety properties

- All writes are atomic (temp file + rename); the previous document is recorded into the log before being replaced.
- The log is trimmed in place past 4 MB, and only records already folded into the document are eligible — a pending refresh never loses its input.
- On graceful shutdown, if the log has reached `PI_HANDOFF_EXIT_CLEAR_LINES` (default 500) records it is wiped entirely for a clean slate; smaller logs are kept so recent snapshot history survives across restarts.
- Secrets: denylist redaction runs when excerpts are appended (before touching disk), before LLM calls, and on LLM output. The summarizer prompt refuses secrets and ignores instructions embedded in the material it summarizes.
- Malformed JSONL lines are tolerated (crash-safe tail); queue state is in-memory only, so a crash can't wedge it.
- Injection is non-destructive and never written into session files.

## Develop

```bash
git clone https://gitlab.fafmgui.corp.fortinet.com ~/.pi/agent/extensions/pi-handoff
```

That location is auto-discovered by pi in all projects. After edits: `/reload`. Quick isolated test: `pi -e ~/.pi/agent/extensions/pi-handoff/index.ts`.

If you also have the git package installed, remove it (`pi remove git:github.com/FleetingEcho/pi-handoff`) — two copies collide on the `/pi-handoff` command and the `write-handoff` skill name.

Loaded as a package, resources come from the `pi` manifest in `package.json` (`extensions: ["./index.ts"]`, `skills: ["./skills"]`) — a bare `index.ts` at the package root is *not* auto-discovered.

| File | Role |
|---|---|
| `index.ts` | Lifecycle wiring, refresh queue, commands |
| `collector.ts` | pi events → redacted, bounded records (no judgment) |
| `summarizer.ts` | Model resolution + the refresh call |
| `injector.ts` | Puts the document into context on every request |
| `store.ts` | Paths, atomic writes, event log, trimming |
| `redact.ts` | Secret denylist |

### Editor / types

Pi's imports are resolved by pi at runtime (jiti) — nothing is required to *run* this extension. For intellisense and type checking, this dir contains symlinks in `node_modules/@earendil-works/*` pointing at the globally installed pi packages (so types always match the running pi version), `@types/node` as a devDependency, and a `tsconfig.json` with `moduleResolution: Bundler` to match jiti's extensionless imports.

```bash
bun run typecheck
```
