---
name: fleet
description: Orchestration policy for offloading large, mechanical, clearly-specifiable execution batches (migrations, boilerplate, mass edits, research fan-outs) to cheaper third-party workers (GLM/z.ai, DeepSeek, OpenRouter, OpenCode Go, ...) via fleet.mjs. You plan, decompose, review and integrate yourself. Use when a task contains a sizable mechanical chunk that a cheap model can execute from a written spec — NOT for small edits, decision-heavy work, or tight iteration with the user. Also use when the user says "fleet", "glm", "deepseek", "openrouter", "opencode", "qwen", "kimi", or "use a cheaper model".
plugin-scoped: true
allowed-tools: Read, Bash, Grep, Glob, TodoWrite
---

# Fleet Orchestrator

You are running as the frontier model — the most capable and most expensive one in reach.
Your strength is **planning, decomposing, reviewing, and long coherent agentic work**. Don't
burn that on grunt work. Mechanical and clearly-scoped execution is **delegated** to cheaper
third-party workers (GLM/z.ai, DeepSeek, OpenRouter, OpenCode Go, ...), and you review their
results.

The workers are separate headless processes dispatched through `scripts/fleet.mjs` — either
`claude -p` pointed at an Anthropic-compatible provider, or `opencode run` (runner
`"opencode"`, which brings its own auth and model catalog). Which providers, models and roles
exist is **user configuration** — never assume; discover it (see Setup check and `list`).

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
The literal form takes **any model id the provider serves**, not just the configured tiers —
e.g. when the user says "use kimi-k3 on opencode go", dispatch
`--provider opencode --model opencode-go/kimi-k3` even though only the tiers appear in the
config. (Model ids on the opencode runner are `catalog/model`, listable via `opencode models`.)

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
node $CLAUDE_PLUGIN_ROOT/scripts/fleet.mjs run --role <role> --resume <session_id> --task "<precise fix>"
```

The `session_id` is in the JSON output of the original `run`. A resume still needs `--role` or
`--provider`, and if the original run used a non-default `--model`, pass the same one again —
otherwise the follow-up runs on the role/provider default. You own the final result, not the
worker.

## Web search: depends on the runner

**`claude` runner (z.ai, DeepSeek, OpenRouter):** `WebSearch` is a server-side Anthropic tool
and is **not available on third-party backends**. Do the search yourself and hand the worker
the **concrete URL(s)** to fetch with `WebFetch`.

**`opencode` runner:** opencode ships its own client-side `websearch` tool (Exa), so these
workers *can* search — no URL pre-collection needed. Two catches:

- The tool is only registered when the provider id is literally `opencode`, or when
  `OPENCODE_ENABLE_EXA=1` is set. **`opencode-go/*` models are a different provider id**, so
  they need that env var. `fleet.mjs` passes the parent env through to the worker, so
  exporting it once is enough. No Exa API key required — it uses the public
  `mcp.exa.ai/mcp` endpoint.
- Exa is an embedding search, not a Google query. When a specific source is mandatory
  (a standard, a statute, a vendor page), still pass the URL rather than trusting its ranking.

Either way, **judging the sources stays with you** — cheap workers do not reliably tell an
authoritative source from SEO filler.

## Cost awareness

The `run` JSON output includes `usage` (tokens) and, when the provider has `pricing` configured,
a computed `cost_usd`. For larger delegation sessions, keep a rough running tally so the user can
see what the fleet is spending.

## When NOT to delegate

Delegation pays off only when the execution you hand off is clearly larger than the spec you
have to write for it — the win comes from price arbitrage plus the worker's small, clean
context, and it scales with batch size. Do it yourself when:

- The expected change is small — rule of thumb: under ~3 files or ~100 changed lines. Writing a
  self-contained spec then costs about as much as doing the task.
- The cheap model is unlikely to land it within one or two review cycles (fuzzy requirements,
  subtle codebase conventions, tricky debugging). Review-fix churn burns your expensive review
  tokens faster than the arbitrage saves.
- Tight, iterative back-and-forth with the user — delegation breaks the thread.
- Tasks whose core is a **decision** (architecture, trade-off, prioritization) — that's your
  job, not delegable.
