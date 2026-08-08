# pi-handoff

Persistent working memory for [pi](https://github.com/badlogic/pi-mono): one automatically maintained handoff per git branch, plus shared project knowledge available on every branch.

The extension records recent turns, periodically folds them into concise Markdown, and injects the result into future sessions. Nothing is written into your repository.

## Install

Requires pi ≥ 0.83.

```bash
pi install git:github.com/FleetingEcho/pi-handoff
```

Restart pi after installing or updating, then run `/pi-handoff` to verify that it loaded.

```bash
pi update --extensions  # update an unpinned git install
pi remove git:github.com/FleetingEcho/pi-handoff
```

## How memory is organized

pi-handoff keeps three kinds of memory with different lifetimes:

| Memory | Scope | Purpose |
|---|---|---|
| `handoff.md` | Current branch | Goal, progress, decisions, active files, and next steps |
| Project knowledge | Every branch | Reviewed architecture, conventions, workflows, reusable decisions, and pitfalls |
| Pinned rules | Every branch | Hard rules and explicit preferences that automated summaries must never rewrite |

Each git branch has an independent `handoff.md`. Switching branches switches handoffs automatically. Project knowledge and pins live in `project.md` and are injected on every branch. Outside a git repository, the directory uses one `default` branch.

## Everyday use

Normally, just work. A background refresh runs roughly every three turns, sooner when a large amount of material accumulates, and before context compaction. Buffered events are durable, so quitting does not need to wait for a model call.

```bash
/pi-handoff status       # paths, pending events, usage, and project suggestions
/pi-handoff flush        # update the current branch handoff immediately
/pi-handoff clear        # start a fresh branch handoff for a new task
/pi-handoff off          # disable collection, refresh, and injection
/pi-handoff on
```

On the next session, start with “keep going” or “what’s left?”; the previous branch handoff is already in context.

The status bar shows the active model, synchronization state, branch, and pending project suggestions:

```text
[Handoff] GLM 5.2 ✓ Synced branch:main
[Handoff] GLM 5.2 ↻ Syncing branch:feature/auth
[Handoff] GLM 5.2 ✓ Synced branch:main · 3 project
```

- Model name: the active model used by the session.
- `✓ Synced`: no handoff refresh is currently running.
- `↻ Syncing`: the branch handoff is being refreshed.
- `○ off`: the extension is disabled.
- `branch:<name>`: the active handoff branch; non-git directories use `default`.
- `· N project`: N project-knowledge suggestions are awaiting review; hidden when zero.

## Shared project knowledge

Run a project refresh when several branches have accumulated useful experience:

```bash
/pi-handoff project refresh
/pi-handoff project          # review queued suggestions
```

`refresh` only calls the model after a branch handoff changes. Changed branches are scanned in bounded batches; each successful batch is checkpointed, so a later failure never marks unprocessed branches as scanned. Deleted/archived Git branch stores are skipped by default; use `/pi-handoff project refresh all` when you deliberately want to mine them too. Candidates may add knowledge or replace/remove facts made stale by newer branch evidence. `/pi-handoff project` (or the explicit `/pi-handoff project review`) shows the exact change, evidence, and source branches before applying it to `project.md`.

You can also manage knowledge directly:

```bash
/pi-handoff project status
/pi-handoff project add Prefer small atomic store mutations
/pi-handoff project add Architecture: Events are the durable source of pending work
/pi-handoff project forget atomic store
```

Direct additions default to `Conventions`. Available sections are:

- `Project Overview`
- `Architecture`
- `Conventions`
- `Workflows`
- `Decisions and Rationale`
- `Known Pitfalls`

The agent-facing `handoff` tool can queue ordinary project knowledge with `project_propose`. Proposals still require user review.

## Pinned rules

Pins are the protected tier. Use them for hard constraints that should never be rephrased or removed automatically:

```bash
/pi-handoff pin Deploys go through ops/deploy.sh, never make release
/pi-handoff pin The staging database is read-only
/pi-handoff unpin staging database
```

Do not pin current task progress, branch-specific state, duplicated documentation, or secrets. Those either belong in the branch handoff or should not be stored.

## Commands

| Command | Purpose |
|---|---|
| `/pi-handoff [status]` | Show store, branch, queue, usage, pins, and project suggestions |
| `/pi-handoff flush` | Refresh the current branch handoff now |
| `/pi-handoff clear` | Start a fresh task handoff; project knowledge and pins remain |
| `/pi-handoff project status` | Show shared knowledge and pending suggestions |
| `/pi-handoff project refresh [all]` | Extract from active branches; `all` includes archived/deleted stores |
| `/pi-handoff project` or `project review` | Accept or reject queued candidates |
| `/pi-handoff project add [Section:] <fact>` | Add shared knowledge directly |
| `/pi-handoff project forget <substring>` | Remove one shared fact; ambiguous matches remove nothing |
| `/pi-handoff pin <rule>` | Add a protected project-wide rule |
| `/pi-handoff unpin <substring>` | Remove one pin; ambiguous matches remove nothing |
| `/pi-handoff on` / `off` | Enable or disable the extension for this session |

The agent tool supports `status`, `flush`, `project_propose`, `pin`, and `unpin`. Destructive controls such as `clear` and `off` remain user-only.

## Storage

All files live outside the project:

```text
~/.agent/agent-handoff/<project>/
├── project.md                 shared knowledge and pinned rules
├── project-candidates.json    suggestion and review state
├── project-meta.json          per-branch project-scan revisions
└── <branch>/
    ├── handoff.md             current branch handoff
    ├── events.jsonl           durable events and document snapshots
    └── meta.json              cursors and session metadata
```

The project key uses the git repository root, so launching pi from different subdirectories reaches the same store. Symlinked paths are resolved, sanitized-name collisions are disambiguated, and older layouts migrate automatically. Set `PI_HANDOFF_DIR` to use another storage root.

The branch document contains seven fixed sections: Current Goal, Progress, Decisions, Constraints, Open Questions, Active Files, and Next Steps. It is capped at roughly 24,000 characters while preserving all section headings.

Shared project knowledge is capped at roughly 16,000 characters because it is injected on every request. When it approaches the limit, replace or remove stale facts before adding more; protected pins use a separate section.

### Storage limits

| File/content | Limit | Cleanup behavior |
|---|---:|---|
| `handoff.md` | 24k characters / 96 KB | Oversized model output is compacted by section; oversized writes are rejected |
| Project knowledge | 16k characters | Existing oversized sections are compacted; new facts are rejected at the limit |
| Pinned rules | 200 rules, 500 characters each, 16k total | New pins are rejected; legacy duplicate/overflow pins are removed with a marker |
| `project.md` | 128 KB | Enforced on every atomic write |
| `events.jsonl` | 1,000 lines / 4 MB | Trims toward 900 lines / 2 MB; pending overflow leaves a summarizer-visible marker |
| `project-candidates.json` | 200 pending + 500 reviewed, 240 characters per field, 1 MB | Oldest excess candidates are removed automatically |
| `project-meta.json` | 2,000 branch hashes / 2 MB | Oldest scan hashes are removed automatically |
| branch `meta.json` | 32 KB | Unknown fields are discarded and known values are normalized on startup |

A collected turn contributes at most about 12k excerpt characters and 200 changed-file paths.

## Reliability and privacy

- Events are appended synchronously before background summarization.
- Document and metadata replacements use unique temporary files plus atomic rename.
- Short-lived filesystem locks coordinate event, metadata, project knowledge, and proposal writes across pi processes; model calls never hold a lock.
- A background refresh refuses to overwrite a handoff edited while its model call was running.
- Refresh cursors only advance past events actually sent to the model.
- Project extraction checkpoints only branch batches actually processed by the model.
- Events arriving during a refresh remain pending for the next batch.
- `events.jsonl` is bounded to 1,000 lines and 4 MB. Trimming prefers folded history; if pending history alone exceeds the hard limit, the newest records are retained with an explicit overflow marker for the summarizer.
- Secret denylist redaction runs before excerpts touch disk, before model calls, and on model output. It is a safeguard, not a guarantee; never intentionally place secrets in handoffs or pins.
- Malformed JSONL tail records are ignored rather than breaking startup.

Two sessions on different branches are isolated. Sessions on the same branch coordinate short disk transactions with filesystem locks; competing summaries use revision checks and retry rather than overwriting a newer document. pi-handoff still warns when it detects another live owner because simultaneous agents may produce noisier combined task history.

## Troubleshooting

**The handoff is not updating.** Check `/pi-handoff status`. A small pending buffer is normal. If refreshes fail, run with `PI_HANDOFF_DEBUG=1`; authentication is inherited from the active pi model.

**Quitting did not refresh.** This is intentional. In-flight work is aborted promptly, while buffered events remain in `events.jsonl` and are folded during a later session.

**The content is stale or wrong.** Edit the Markdown directly, run `/pi-handoff clear` for a new task, or use `project forget` for incorrect shared knowledge. Pin only corrections that must remain permanent.

**I need an older handoff.** Previous documents are stored as `snapshot` records in `events.jsonl`:

```bash
grep '"snapshot"' /path/to/events.jsonl | tail -1 | jq -r .doc
```

## Development

```bash
npm install
npm run typecheck
```

The pi runtime packages are optional peer dependencies: pi resolves them when loading the extension without installing a second runtime copy. For local type checking, make those package types available from the installed pi runtime or install them temporarily without saving.

Main files:

| File | Role |
|---|---|
| `index.ts` | Lifecycle, refresh queue, commands, and agent tool |
| `store.ts` | Paths, migrations, project knowledge, events, and atomic persistence |
| `collector.ts` | Deterministic redacted turn collection |
| `summarizer.ts` | Branch refresh and project-knowledge extraction |
| `injector.ts` | Branch and project context injection |
| `redact.ts` | Secret denylist |

The package also includes `/skill:write-handoff` for manually writing a handoff to a user-selected path.
