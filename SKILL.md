---
name: write-handoff
description: Compact the current conversation into a handoff document for another agent to pick up.
argument-hint: "What will the next session be used for?"
---

Write a handoff document summarising the current conversation so a fresh agent can continue the work.

The pi-handoff extension already auto-maintains one for this working directory (read it first). It lives **outside the project**, in a per-project directory under `~/.pi/agent/pi-handoff/` named after this directory's absolute path — run `/pi-handoff status` to print the exact path, then read `<store>/handoff.md`.

Do **not** overwrite that file — the extension owns it. If the automatic document is already accurate, say so and stop; otherwise run `/pi-handoff flush` to refresh it from the latest events, or write your manual version to a path the user chooses.

Include a "suggested skills" section in the document, which suggests skills that the agent should invoke.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs) or already present in handoff.md — reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.
