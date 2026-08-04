# subagent-fleet — Design & Plan

> Status: implemented. Describes **what** was built and **why**.

## Problem / Idea

A frontier model (Fable 5, Opus, GPT-5, …) is strong as an **orchestrator + reviewer**,
but expensive. Mechanical and clearly-scoped execution (coding to spec, research,
mass edits) does not need to run on the most expensive model. Goal:

> The orchestrator plans, decomposes, **delegates execution to cheaper third-party
> workers (GLM/z.ai, DeepSeek, OpenRouter, …)** and **reviews** their results. Which
> providers and models the workers use is pure **configuration** — drop in credentials,
> define models, done.

Not tied to any one `.zshrc`, not tied to Fable, not tied to an Anthropic subscription.
Other users should be able to install it, enter their keys, and go.

## Core constraint (why a dispatch script is needed)

The built-in **Task tool inherits `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` from the
parent process**. A running session has **exactly one backend**; the only per-subagent
knob is the *model name* served by that one backend. So there is **no** way to send a
subagent to z.ai while the orchestrator runs on Anthropic.

→ Mechanism: For each delegated task the orchestrator invokes a separate
**`claude -p` (headless)** via **Bash**, with provider-specific env variables. Each worker
is its own Claude Code instance, authenticated against the third-party provider; the
Anthropic auth is removed from the worker process. The result (including token usage and
`session_id`) comes back as JSON and the orchestrator reviews it. (Same basic principle
as `ethanhq/cc-fleet`.)

Verified: `claude -p "…" --output-format json --model … --allowedTools … --permission-mode
… --append-system-prompt …` exists and returns `{ result, session_id, total_cost_usd,
usage, num_turns, … }`. Also verified present: `--resume <session-id>`,
`--setting-sources`, `--strict-mcp-config`.

## Worker isolation (important)

A spawned `claude -p` loads the **entire user/project configuration** by default:
`~/.claude/settings.json`, project settings, all plugins, hooks and MCP servers.
Consequences: the user's hooks fire inside the worker, MCP servers restart per worker
(latency), and the fleet skill would load itself into every worker.

Therefore `fleet.mjs` starts workers **isolated by default**:

- `--setting-sources ""` (no user/project settings, no plugins/hooks) — overridable via
  config (`settingSources`) in case someone needs project settings inside a worker.
- `--strict-mcp-config` (no MCP servers unless explicitly requested via config).
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` in the worker env (no update check /
  telemetry).
- Anthropic auth removed: `ANTHROPIC_API_KEY`, OAuth tokens etc. are deleted from the env
  so no subscription and no wrong key leaks through. Bedrock/Vertex routing toggles are
  stripped as well.

## Provider compatibility

The env-var approach only works with **Anthropic-Messages-compatible** endpoints:

| Provider   | Base URL                          | Compatible |
|------------|-----------------------------------|------------|
| DeepSeek   | `https://api.deepseek.com/anthropic` | ✓ |
| z.ai / GLM | `https://api.z.ai/api/anthropic`     | ✓ |
| OpenRouter | `https://openrouter.ai/api`          | ✓ ("Anthropic skin", incl. tool-use/thinking) |

Base URLs are not taken on faith from docs: **`fleet.mjs doctor --ping`** makes a minimal
one-turn call per provider and verifies the whole chain (URL, auth, model name) for cents.

Claude Code makes additional internal calls with a Haiku-class model (summaries etc.).
On a third-party backend those fail with the default Claude model name — so each provider
has a **`smallFastModel`** that is set as `ANTHROPIC_SMALL_FAST_MODEL` (and
`ANTHROPIC_DEFAULT_HAIKU_MODEL`) in the worker env.

Pure OpenAI-format providers need a shim (claude-code-router / LiteLLM) — deliberately
not part of v1. Since v1.1 the **opencode runner** (below) covers them without a shim.

## Components

```
plugins/subagent-fleet/
  .claude-plugin/plugin.json
  scripts/fleet.mjs              # dispatch CLI (Node, no dependencies)
  fleet.config.example.json      # template: providers + roles (no secrets)
  skills/fleet/SKILL.md          # orchestration policy (provider-agnostic)
  README.md
  DESIGN.md                      # this document
```

### 1. Configuration (`fleet.config.json`)

Secrets are **never** stored in the config — only the **name** of the env variable.
Search order: `$FLEET_CONFIG` → `$CLAUDE_PROJECT_DIR/.claude/fleet.config.json` →
`./.claude/fleet.config.json` → `$CLAUDE_CONFIG_DIR/fleet.config.json` →
`~/.claude/fleet.config.json`.

```jsonc
{
  // optional: dotenv file to load keys from (generic, no fixed path)
  "envFile": "~/.config/fleet/.env",
  "providers": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com/anthropic",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "smallFastModel": "deepseek-v4-flash",
      "models": { "strong": "deepseek-v4-pro", "default": "deepseek-v4-flash", "fast": "deepseek-v4-flash" },
      // optional: prices per 1M tokens → fleet.mjs computes cost itself (USD)
      "pricing": { "deepseek-v4-pro": { "input": 0.6, "output": 2.4 } }
    },
    "zai": {
      "baseUrl": "https://api.z.ai/api/anthropic",
      "apiKeyEnv": "ZAI_API_KEY",
      "smallFastModel": "glm-5.2-air",
      "models": { "strong": "glm-5.2", "default": "glm-5.2", "fast": "glm-5.2-air" }
    },
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "smallFastModel": "z-ai/glm-4.6",
      "models": { "strong": "deepseek/deepseek-v4", "default": "z-ai/glm-4.6", "fast": "z-ai/glm-4.6" }
    }
  },
  "roles": {
    "coder":      { "provider": "zai",      "model": "strong", "tools": "Read,Edit,Write,Grep,Glob,Bash" },
    "researcher": { "provider": "deepseek", "model": "fast",   "tools": "Read,Grep,Glob,WebFetch" },
    "grunt":      { "provider": "deepseek", "model": "fast",   "tools": "Read,Edit,Write,Grep,Glob" }
  },
  "defaults": { "permissionMode": "acceptEdits", "maxTurns": 40, "timeoutSec": 1800 }
}
```

Note on model names: values are examples; `doctor --ping` verifies the real names.
(No `[1m]` suffix — that is an Anthropic/Claude Code convention, not a third-party
model name.)

### 2. Dispatch CLI (`scripts/fleet.mjs`)

Node, no external dependencies. Commands:

- `fleet.mjs doctor [--ping]` — lists providers + key status; with `--ping` a minimal
  live call per provider (verifies URL/auth/model name).
- `fleet.mjs list` — shows configured roles/providers/models.
- `fleet.mjs run --role <role> --task "<text>" [--cwd <dir>] [--format json|text]`
  - Alt.: `--provider <id> --model <tier|literal>`; `--task-file <path>` or stdin.
  - builds the worker env: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`,
    `ANTHROPIC_SMALL_FAST_MODEL`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`;
    **removes** `ANTHROPIC_API_KEY`/OAuth tokens. The model is passed via `--model`
    (not additionally via env — avoid redundancy).
  - execs `claude -p <task> --output-format json --model … --allowedTools …
    --permission-mode … --max-turns … --setting-sources "" --strict-mcp-config
    --append-system-prompt <worker-preamble>` in the chosen `cwd`;
  - **hard timeout** (`timeoutSec`, default 30 min): worker is killed (whole process
    group), error JSON returned.
  - Output for the orchestrator: `result`, `session_id`, `usage` (tokens), computed cost
    (from `pricing` if configured — the CLI's own `total_cost_usd` is unreliable for
    third-party models since it is computed with Anthropic prices), exit code != 0 on
    error.
- `fleet.mjs run --resume <session-id> --task "<follow-up>"` — **review loop**: continues
  the worker session with full context (same env setup as the initial dispatch).
  If a review fails, the fix costs only the delta instead of a fresh worker.

**Worker preamble** (append-system-prompt): "You are a delegated worker. Do exactly the
assigned task, no scope expansion. You cannot ask questions — if a real decision is
needed, state it and stop. Answer concisely: what was done, which files changed, what was
verified, what remains open. Your edits will be reviewed by the orchestrator."

### 3. Skill (`skills/fleet/SKILL.md`)

Provider-agnostic orchestration policy. Triggers: "fleet", "delegate", "subagent",
"glm/deepseek/openrouter", "cheaper model". Content:

- The orchestrator's role: understand, plan, **decompose**, delegate, **review**, integrate.
- Delegate = `node $CLAUDE_PLUGIN_ROOT/scripts/fleet.mjs run --role … --task "…" --cwd .`.
- **Start non-trivial dispatches via `run_in_background`** (the orchestrator's Bash tool
  has a 10-minute timeout; workers may run longer).
- Complete, self-contained assignments (a worker cannot ask questions).
- **Review is mandatory**: code → `git diff`, research → check the output. The
  orchestrator owns the final result. If a review fails → `--resume <session-id>` with a
  precise fix assignment instead of a fresh worker.
- **Parallelism**: parallel workers only on **disjoint files**; otherwise sequential or
  per git worktree (point `--cwd` at a worktree).
- Web search depends on the runner: on the `claude` runner it stays with the orchestrator
  (WebSearch is a server-side Anthropic tool, not available on third-party backends) and
  workers get concrete URLs for `WebFetch`. The `opencode` runner has its own client-side
  `websearch` (Exa) — but only for provider id `opencode`, or with `OPENCODE_ENABLE_EXA=1`
  for `opencode-go/*`. Judging the sources stays with the orchestrator either way.
- Cost awareness: the JSON output contains token usage + computed cost if configured.
- When **not** to delegate: changes below break-even (roughly <3 files / <100 lines — the
  spec costs as much as the task), work the cheap model won't land in 1–2 review cycles,
  tight iteration with the user, pure decisions.

## opencode runner (v1.1)

Motivation: subscription plans like **OpenCode Go** ($10/month: GLM-5.2, Qwen 3.7, Kimi K3,
DeepSeek, ...) serve most models only in **OpenAI format** — unreachable for `claude -p`
workers. (Qwen/MiniMax are the exception: Zen exposes them Anthropic-compatibly under
`https://opencode.ai/zen/go/v1/messages`.) Instead of a shim, workers can run on the
**opencode CLI**, which speaks both formats natively.

Per-provider field `"runner": "opencode"` (default `"claude"`). Differences:

- **No `baseUrl`/`apiKeyEnv`** — auth comes from `opencode auth` / `/connect`
  (`~/.local/share/opencode/auth.json`). `doctor` checks the binary; `doctor --ping` does a
  real 1-turn run.
- **Model ids** are `catalog/model` (e.g. `opencode-go/glm-5.2`), listable via
  `opencode models`. Tiers resolve exactly like on the claude runner; literals pass through.
- **Dispatch**: `opencode run --model <id> --format json --pure --dir <cwd> [--auto]
  [--agent <name>] [--session <id>] "<preamble + task>"`.
  - `--format json` emits **NDJSON events** (`step_start`, `text`, `step_finish`, `error`);
    fleet.mjs concatenates `text` parts, sums `step_finish` tokens
    (`{input, output, reasoning, cache:{read,write}}`) and `cost`, and normalizes into the
    same output JSON as the claude runner.
  - **`--dir` is mandatory**: opencode resolves its working directory from the environment
    (`PWD`), *not* from the child-process cwd — without `--dir` a worker edits files in the
    orchestrator's directory. Verified empirically; fleet.mjs sets both `--dir` and `PWD`.
  - No `--append-system-prompt` → the worker preamble is prepended to the task message.
  - No `--allowedTools` / `--max-turns` → role `tools` is ignored (with a warning); tool
    restriction goes through opencode **agents** (role field `agent` / flag `--agent`).
  - `permissionMode` `acceptEdits`/`bypassPermissions` map to `--auto` (headless workers
    can't answer prompts); anything else runs with opencode's default permissions.
  - Resume: `--resume <session_id>` maps to opencode's `--session`. The `sessionID` from the
    event stream is returned as `session_id`.
- **Cost**: config `pricing` wins; otherwise opencode's summed per-step `cost` is reported as
  `cost_source: "opencode-reported"` (models.dev pricing — notional on flat-rate plans).

Verified live against OpenCode Go (opencode 1.18.9) on 2026-07-29: doctor/ping, dispatch with
`opencode-go/glm-5.2` (file created in `--cwd`), resume with retained context, ad-hoc literal
model (`opencode-go/kimi-k3`), error path (unknown model → `ok:false`, exit 1).

## Security

- No secrets in the repo/config — only env-var names; keys come from the env or the
  optional `envFile`.
- Never set `ANTHROPIC_BASE_URL` globally — only inline in the worker subprocess.
- Workers run in a defined `cwd`; edits are reviewable via `git diff`.
- **`--allowedTools` is a permission allowlist**: whatever is listed runs without
  prompting. A role with `Bash` effectively has **full shell access** in its `cwd`,
  regardless of `permissionMode`. Consequence: give `Bash` only to roles that need it
  (in the example, `grunt` deliberately has none); the README points this out explicitly.
- `permissionMode` is configurable; `bypassPermissions` only as a deliberate opt-in.

## Test / Definition of Done

1. `fleet.mjs doctor` shows the providers + key status; `doctor --ping` verifies at least
   one provider live.
2. Real dispatch with the **cheapest model**: trivial coding task in a temp directory,
   worker creates a file → JSON with `result`, `session_id`, usage; file exists. Proof
   that it really works.
3. **Resume test**: follow-up via `--resume` on the same worker session; the worker has
   the context of the initial assignment.
4. Proof that the orchestrator session (Anthropic) remains untouched (no Anthropic auth
   in the worker env; a worker task prints the relevant `ANTHROPIC_*` var names, never
   values).
5. Timeout test: set `timeoutSec` low → worker is killed, clean error JSON.

All five verified against live DeepSeek/z.ai endpoints on 2026-07-01.

## Relation to the old `fable-orchestrator`

The previous plugin delegated only **within Anthropic** (haiku/sonnet/opus,
subscription-native) and was Fable-branded. `subagent-fleet` generalizes: any
orchestrator, third-party providers via config. The old plugin folder moved to
`archive/`; `marketplace.json` was updated accordingly.
