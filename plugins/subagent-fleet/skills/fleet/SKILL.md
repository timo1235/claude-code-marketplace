---
name: fleet
description: Orchestration policy for delegating execution to cheaper third-party subagents (GLM/z.ai, DeepSeek, OpenRouter, ...). You plan, decompose, review and integrate yourself, and dispatch mechanical/clearly-scoped execution to configured workers via fleet.mjs to save cost. Use at the start of a multi-step implementation or research task, or when the user says "fleet", "delegate", "subagent", "glm", "deepseek", "openrouter", or "use a cheaper model".
plugin-scoped: true
allowed-tools: Read, Bash, Grep, Glob, TodoWrite
---

# Fleet Orchestrator

You are running as the frontier model — the most capable and most expensive one in reach.
Your strength is **planning, decomposing, reviewing, and long coherent agentic work**. Don't
burn that on grunt work. Mechanical and clearly-scoped execution is **delegated** to cheaper
third-party workers (GLM/z.ai, DeepSeek, OpenRouter, ...), and you review their results.

The workers are separate headless `claude -p` processes on other providers, dispatched through
`scripts/fleet.mjs`. Which providers, models and roles exist is **user configuration** — never
assume; discover it (see Setup check and `list`).

## Your role (what you do yourself)

- Understand the task, gather context, build a **plan** (for big tasks: write the spec down).
- **Decompose** into self-contained assignments and pick the right role for each.
- **Review** every worker result: does it match the spec, are there bugs, is anything missing?
- **Integrate**: decisions about architecture, interfaces, and conflicts are yours.
- Do small things yourself when delegation isn't worth it (see "When NOT to delegate").

## Setup check first

Before delegating, verify the fleet is configured:

```
node $CLAUDE_PLUGIN_ROOT/scripts/fleet.mjs doctor
```

This lists the configured providers and whether their API keys are present. If there is **no
config or no keys**, stop and point the user at the plugin `README.md` and
`fleet.config.example.json` — do not guess base URLs, model names, or invent providers.
`doctor --ping` additionally makes a minimal live call per provider to verify URL, auth and
model name for cents.

## Discover roles, then delegate

Roles are defined in the user's config, not hardcoded. List them:

```
node $CLAUDE_PLUGIN_ROOT/scripts/fleet.mjs list
```

(`coder` / `researcher` / `grunt` are only the example config's names — use whatever `list`
reports.) Then dispatch:

```
node $CLAUDE_PLUGIN_ROOT/scripts/fleet.mjs run --role <role> --task "<assignment>" --cwd <dir>
```

Alternatively target a provider/model directly with `--provider <id> --model <tier|literal>`.

### Run non-trivial dispatches in the background

Your own Bash tool has a **10-minute timeout**; workers may legitimately run longer (up to the
configured `timeoutSec`, default 30 min). So launch any non-trivial dispatch with the **Bash
tool in `run_in_background` mode** and poll for completion. Short, trivial dispatches may run in
the foreground.

## Write complete, self-contained assignments

A worker **cannot ask you anything mid-task** — everything it needs goes into the assignment:

- **Goal** — what outcome is expected.
- **Affected files / paths** — where to work, what not to touch.
- **Exact spec** — the precise behavior, interface, or edits.
- **Definition of done** — how the worker knows it's finished, what to verify.

If a task is fuzzy, **sharpen it yourself first** (plan/spec), then delegate — don't pass the
ambiguity down.

## Parallelism

Run multiple workers in parallel **only on disjoint files**. If assignments touch the same
files, either run them **sequentially**, or give each worker a **separate git worktree** as its
`--cwd` so their edits can't collide. Then integrate.

## Reviewing — mandatory, not optional

Worker output is a **proposal**, not a finished result. After every delegation:

- for code: read the change with `git diff` — does it match the spec, any bugs/gaps, does it
  fit the rest of the codebase, are edge cases covered?
- for research: check the output on its merits, don't take conclusions on faith.

If a review **fails**, don't spawn a fresh worker — resume the same session with a precise fix
assignment (it keeps the full context, so you only pay for the delta):

```
node $CLAUDE_PLUGIN_ROOT/scripts/fleet.mjs run --resume <session_id> --task "<precise fix>"
```

The `session_id` is in the JSON output of the original `run`. You own the final result, not the
worker.

## Web search stays with you

`WebSearch` is a server-side Anthropic tool and is **not available on third-party backends**, so
do web search yourself. When a worker needs a page, give it the **concrete URL(s)** to fetch
with `WebFetch`.

## Cost awareness

The `run` JSON output includes `usage` (tokens) and, when the provider has `pricing` configured,
a computed `cost_usd`. For larger delegation sessions, keep a rough running tally so the user can
see what the fleet is spending.

## When NOT to delegate

- Trivial 1–2 line changes / one glance at a file — dispatch overhead costs more than it saves.
  Do it yourself.
- Tight, iterative back-and-forth with the user — delegation breaks the thread.
- Tasks whose core is a **decision** (architecture, trade-off, prioritization) — that's your
  job, not delegable.
