# Changelog

## [Unreleased]

### Added

- Working `/pi-handoff` default status, a `help` command, and nested project-command completion.
- Regression tests for pin privacy, model output limits, lock contention, candidate caches, and command parsing.
- Reproducible local tests and type checks with Pi 1.5.2 development-only dependencies.

### Changed

- Cache parsed event logs and project candidates by file identity while retaining mutation-safe copies for callers.
- Yield to pi's event loop while turn collection waits for a contested write lock.
- Serialize each event once when selecting a background-refresh batch.

### Fixed

- Use the same redacted pin in `project.md` and `events.jsonl`, preventing raw pins from reaching later model calls.
- Never request more output tokens than the selected model supports.
- Correct documentation for refresh thresholds, compaction timing, and document limits.
- Drain pending collector writes during shutdown and tolerate non-object JSONL records during startup.
- Preserve legacy or manually edited knowledge when shared with OpenCode while adding missing project section headings.

## [0.12.0] - 2026-11-17

### Added

- Native pi 1.5 update notices through the package changelog manifest.
- Visible refresh-error status and a first-failure warning while preserving all buffered events for retry.
- CJK-aware task-change detection for Chinese, Japanese, and Korean prompts.

### Changed

- Route background summaries through pi's current model registry, including OAuth, cloud credentials, custom providers, and virtual models.
- Mark background calls as standalone so they do not interfere with provider conversation threads.
- Read `.git/HEAD` directly in normal repositories and worktrees instead of spawning Git on every prompt.
- Cache the project-suggestion count by file identity instead of reparsing its bounded JSON file on every status-bar update.
- Refresh after compaction in the background instead of blocking compaction or overflow recovery on a second model call.
- Refresh injected memory immediately after explicit pin or project-knowledge edits.
- Read and parse `project.md` once when building injected context.

### Fixed

- Report a failed manual flush as a failure instead of claiming that `handoff.md` was refreshed.
- Preserve aborted/error turn context without presenting an incomplete assistant response as completed work.
- Narrow the latest pi `before_agent_start` event correctly for custom-message runs.
