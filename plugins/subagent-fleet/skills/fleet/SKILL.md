---
name: fleet
description: Use when a task contains a sizable mechanical, clearly-specifiable execution batch — migrations, boilerplate, mass edits, research fan-outs — that a cheap third-party worker (GLM/z.ai, DeepSeek, OpenRouter, OpenCode Go, ...) could execute from a written spec. NOT for small edits, decision-heavy work, or tight iteration with the user. Also use when the user says "fleet", "glm", "deepseek", "openrouter", "opencode", "qwen", "kimi", or "use a cheaper model".
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

For anything longer than a couple of lines, **write the assignment to a file and pass
`--task-file <path>`** instead of `--task` — a multi-paragraph spec in a shell argument breaks
on quotes, backticks and `$`. Use `--timeout <sec>` when the batch may exceed the configured
`timeoutSec`. Full flag list: `fleet.mjs --help`.

Alternatively target a provider/model directly with `--provider <id> --model <tier|literal>`.
The literal form takes **any model id the provider serves**, not just the configured tiers —
e.g. when the user says "use kimi-k3 on opencode go", dispatch
`--provider opencode --model opencode-go/kimi-k3` even though only the tiers appear in the
config. (Model ids on the opencode runner are `catalog/model`, listable via `opencode models`.)

### Run non-trivial dispatches in the background

Your own Bash tool defaults to a **2-minute timeout** and caps at 10 minutes; workers may
legitimately run far longer (up to the configured `timeoutSec`, default 30 min). So launch any
non-trivial dispatch with the **Bash tool in `run_in_background` mode** and poll for completion.
Short, trivial dispatches may run in the foreground.

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

Parallel workers on one provider **share that provider's quota**. Four strong-tier coders on
one z.ai key drained a full five-hour window in twenty minutes and died mid-file. `fleet.mjs`
enforces `maxParallel` per provider (default 2 — a third run waits for a slot), but plan for it
too: spread a wave over providers (two on z.ai, one on OpenRouter, …) rather than stacking
everything on one key, and stagger starts when the packages are large.

## Peak hours

Some flat-rate plans meter quota faster at certain times (z.ai: `glm-5.3` counts 3× Mon–Fri
14:00–18:00 UTC+8 = 08:00–12:00 German time). `doctor` shows whether a provider's peak is
**ACTIVE NOW**, and `run` reports `quota_multiplier`. During peak, dispatch fewer strong-tier
workers to that provider, use the fast tier or another provider for the bulk, or postpone a
large fan-out — a 3× wave is how a five-hour quota vanishes in twenty minutes.

## Keep runs short and resumable

A run that dies loses everything since its last write, and the longer it runs the likelier it
dies. Size assignments so a worker finishes in **under ~15 minutes / ~40 turns**; split bigger
work into sequential packages instead of one 40-minute run. Always dispatch with
`--task-file` — that also gives the worker a **progress file** (`<task-file>.progress.md`) it
checkpoints each deliverable into, so a resume picks up where it stopped instead of guessing.
Tell the worker to write each file as soon as it is designed, not at the end.

## When a run fails

Read `error_class` in the output before doing anything:

- `rate_limit` — the quota is gone. `fleet.mjs` already tried the provider's `fallback`; if it
  still failed, `retry_after_sec` / `reset_at` tell you when. Do **not** hammer the same
  provider again — resume on another provider or wait.
- `transient` / `empty_response` — the automatic retries (`maxRetries`, default 3) were
  exhausted. Resume the session once more by hand (`--resume <session_id>`); if it dies again,
  the package is too big — split it.
- `timeout` — the run exceeded `timeoutSec`. `session_id` is still reported: resume it with a
  smaller remaining scope, or pass `--timeout` if the package genuinely needs longer.
- `max_turns` — the turn budget was the point; review what exists before granting more.
- `error` — read `error` / `stderr` / `diagnostics`; this is not a retry case.

Never restart a dead worker from scratch while its `session_id` is known — a resume keeps the
full context and the progress file tells it what is done.

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

## Web search: depends on the provider

**z.ai:** its Anthropic-compatible endpoint implements the server-side tool
`web_search_20250305` and routes it internally to its own `web_search_prime` (verified
2026-09-13 against the raw endpoint and in a `claude -p` transcript). z.ai workers **can** use
`WebSearch` — put it in the role's `tools` and skip pre-collecting URLs.

**DeepSeek, OpenRouter:** unverified. Assume `WebSearch` is unavailable there until a test
dispatch proves otherwise, and hand those workers the **concrete URL(s)** to fetch with
`WebFetch`.

**`opencode` runner:** opencode ships its own client-side `websearch` tool (Exa), so these
workers can search too. Two catches:

- The tool is only registered when the provider id is literally `opencode`, or when
  `OPENCODE_ENABLE_EXA=1` is set. **`opencode-go/*` models are a different provider id**, so
  they need that env var. `fleet.mjs` passes the parent env through to the worker, so
  exporting it once is enough. No Exa API key required — it uses the public
  `mcp.exa.ai/mcp` endpoint.
- Exa is an embedding search, not a Google query.

**Regardless of provider:** when a specific source is mandatory (a standard, a statute, a vendor
page), pass the URL rather than trusting the search ranking. And **judging the sources stays
with you** — cheap workers do not reliably tell an authoritative source from SEO filler.

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
