# subagent-fleet

Run your **orchestrator** on an expensive frontier model (Fable, Opus, GPT-5, ...) and push the
actual **execution** down to cheaper third-party providers — z.ai/GLM, DeepSeek, OpenRouter
(Anthropic-compatible endpoints), or anything the **opencode CLI** can reach (e.g. the OpenCode
Go plan with GLM, Qwen, Kimi, DeepSeek). The orchestrator plans, decomposes, delegates and
reviews; the workers do the mechanical, clearly-scoped work. Which providers, models and roles
the workers use is pure **configuration** — drop in credentials, define models, done. Not tied
to any one shell config, not tied to Fable, not tied to an Anthropic subscription.

## How it works

The built-in Task tool **inherits the parent process's backend** (`ANTHROPIC_BASE_URL` /
`ANTHROPIC_AUTH_TOKEN`). A running session has exactly one backend, and the only per-subagent
knob is the *model name* that this one backend serves — so the Task tool **cannot** send a
subagent to z.ai while the orchestrator stays on Anthropic.

So instead, for each delegated task the orchestrator runs a separate **headless worker
process**. Two runners exist, selected per provider via the `runner` field:

- **`claude`** (default) — a headless `claude -p` with provider-specific env vars, pointed at an
  **Anthropic-Messages-compatible** endpoint. Each worker is its own Claude Code instance,
  authenticated against the third-party provider; the Anthropic auth is stripped from the
  worker's env.
- **`opencode`** — a headless `opencode run`. Auth and the model catalog come from the opencode
  CLI itself (`opencode auth` / `/connect`), so no baseUrl or API key appears in the fleet
  config, and **OpenAI-format-only models** (e.g. `glm-5.3` or `kimi-k3` on the OpenCode Go
  plan) become reachable. Model ids are `catalog/model`, e.g. `opencode-go/glm-5.3` — list them
  with `opencode models`.

Either way the result (including token usage and a `session_id` for follow-ups) comes back as
the same JSON shape, and the orchestrator reviews it.

Workers on the claude runner are **isolated** by default: no user/project settings, no plugins,
no hooks, no MCP servers. This keeps your local config out of every worker and avoids
re-spawning MCP servers per dispatch. (Overridable in config if you actually need project
settings inside a worker.) opencode workers run with `--pure` (no external opencode plugins).

## Setup

1. **Config file.** Copy `fleet.config.example.json` to one of these (searched in this order):

   - `$FLEET_CONFIG` (explicit path)
   - `$CLAUDE_PROJECT_DIR/.claude/fleet.config.json`
   - `./.claude/fleet.config.json` (project-local)
   - `$CLAUDE_CONFIG_DIR/fleet.config.json` (if you use a custom config dir)
   - `~/.claude/fleet.config.json` (user-global)

2. **API keys.** The config only ever stores the **name** of an env var, never a secret. Provide
   the keys as environment variables, or point the config's optional `envFile` at a dotenv file
   that holds them.

3. **Verify.**

   ```
   node scripts/fleet.mjs doctor          # lists providers + whether each key is present
   node scripts/fleet.mjs doctor --ping   # minimal live call per provider: verifies URL/auth/model
   ```

### Config format

```jsonc
{
  // optional: dotenv file the keys are loaded from
  "envFile": "~/.config/fleet/.env",

  "providers": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com/anthropic",
      "apiKeyEnv": "DEEPSEEK_API_KEY",         // name of the env var, not the key itself
      "smallFastModel": "deepseek-v4-flash",   // model for Claude Code's internal Haiku-class calls
      "models": { "strong": "deepseek-v4-pro", "default": "deepseek-v4-flash", "fast": "deepseek-v4-flash" },
      // optional: price per 1M tokens in USD → fleet.mjs computes cost itself.
      // Without it, run output has cost_usd: null — you fly blind on spend.
      // Skip it only on flat-rate plans, where a per-token number would mislead.
      "pricing": {
        "deepseek-v4-pro":   { "input": 1.74, "output": 3.48 },
        "deepseek-v4-flash": { "input": 0.14, "output": 0.28 }
      }
    },
    // ... zai, openrouter, ...

    // opencode runner: no baseUrl/apiKeyEnv — auth comes from `opencode auth`.
    // Model ids are catalog/model (see `opencode models`).
    "opencode": {
      "runner": "opencode",
      "models": {
        "strong": "opencode-go/glm-5.3",
        "default": "opencode-go/glm-5.3",
        "fast": "opencode-go/glm-5.3-flash"
      }
    }
  },

  "roles": {
    // provider: which provider; model: a tier name (strong/default/fast) or a literal model id;
    // tools: the worker's allowed-tools allowlist
    "coder":      { "provider": "zai",      "model": "strong", "tools": "Read,Edit,Write,Grep,Glob,Bash" },
    "researcher": { "provider": "zai",      "model": "fast",   "tools": "Read,Grep,Glob,WebSearch,WebFetch" },
    "grunt":      { "provider": "deepseek", "model": "fast",   "tools": "Read,Edit,Write,Grep,Glob" }
  },

  "defaults": {
    "permissionMode": "acceptEdits", "maxTurns": 40, "timeoutSec": 1800,
    "maxParallelPerProvider": 2, "maxRetries": 3, "retryBackoffSec": 15, "rateLimitWaitMaxSec": 0
  }
}
```

- **providers** — on the default claude runner, each has a `baseUrl` (Anthropic-Messages-
  compatible endpoint), an `apiKeyEnv` (the env-var *name*), a `smallFastModel` (Claude Code
  makes internal Haiku-class calls; on a third-party backend the default Claude model name
  fails, so this one is used instead), a `models` map with the `strong` / `default` / `fast`
  tiers, and optional `pricing` per model. With `"runner": "opencode"` only `models` is
  required; auth is the opencode CLI's own.
- **roles** — a named worker profile: which `provider`, which `model` (a tier name or a literal
  model id), and the `tools` allowlist (claude runner only — opencode workers restrict tools
  via an opencode **agent**, selectable per role with an `agent` field or per run with
  `--agent`).
- **defaults** — `permissionMode`, `maxTurns`, and the hard-kill `timeoutSec` (default 30 min).
  Optionally `settingSources` (default `""` = fully isolated worker) if you need user/project
  settings inside workers, `workerStateDir` (see below), and the retry / concurrency knobs
  `maxParallelPerProvider`, `maxRetries`, `retryBackoffSec`, `rateLimitWaitMaxSec` (see
  "Failure handling"). Per provider: `fallback`, `rateLimitTz`, `maxParallel`.

### Worker session storage

Both runners persist a session per worker run, and by default they persist it into the same
store the orchestrator uses — `claude -p` writes
`$CLAUDE_CONFIG_DIR/projects/<slug>/<uuid>.jsonl`, `opencode run` writes
`~/.local/share/opencode/opencode.db`. Anything that lists those as sessions (the `/resume`
picker, session-browsing UIs such as CloudCLI) then fills up with worker transcripts.

Workers therefore get a state dir of their own, `~/.local/state/subagent-fleet` by default:

| Runner | Variable set for the worker | Worker sessions land in |
|---|---|---|
| `claude` | `CLAUDE_CONFIG_DIR` | `<stateDir>/claude/projects/…` |
| `opencode` | `OPENCODE_DB` | `<stateDir>/opencode/fleet.db` |

This is free of side effects: workers already run with `--setting-sources ""`, so they read
nothing out of the orchestrator's config dir, and neither variable touches auth — the claude
runner authenticates from `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` in the environment, and
opencode's `auth.json` stays in the shared data dir next to the relocated database. `--resume`
keeps working, since a resumed run gets the same environment.

- `"workerStateDir": "~/somewhere/else"` — put it elsewhere.
- `"workerStateDir": ""` — opt out; workers share the orchestrator's state again.
- An inherited `CLAUDE_CONFIG_DIR` / `OPENCODE_DB` always wins, so you can override per call.

The state dir is pure scratch — delete it whenever you like; only `--resume` of an older
worker session depends on it.

### Failure handling, retries and quotas

Parallel workers on one provider key share **one quota**. Four `glm-5.3` coders drained a full
five-hour z.ai window in twenty minutes and two of them died mid-file with a 429 — while the
dispatcher treated that as a fatal error and threw the session away. `run` therefore does three
things on its own now:

- **Concurrency slots.** A run takes a slot under `<workerStateDir>/slots/<provider>/` and
  waits (message on stderr) while the provider already has `maxParallel` /
  `defaults.maxParallelPerProvider` (default 2) live workers. `--max-parallel 0` disables it.
- **Classified retries.** Every failure gets an `error_class`:

  | class | meaning | action |
  |---|---|---|
  | `rate_limit` | 429 / quota exhausted | continue the *same session* on `provider.fallback` (same runner); else wait if the reset is within `rateLimitWaitMaxSec`; else fail with `retry_after_sec` / `reset_at` |
  | `transient` | dropped stream, network error, 5xx, process died mid-stream | resume the same session after `retryBackoffSec · 2^n` |
  | `empty_response` | the model returned nothing ("No response requested.") | resume with a nudge |
  | `max_turns`, `timeout`, `error` | budget exhausted / hard kill / anything else | not retried |

  Up to `maxRetries` (default 3, `--retries <n>`) retries. Because the claude runner's session
  transcript is local, a fallback provider picks up the full context — nothing is redone.
  Providers phrase reset times as a wall clock in their own timezone; set `rateLimitTz`
  (z.ai: `"+08:00"`) so `retry_after_sec` can be computed.
- **Checkpoints.** With `--task-file`, the worker gets a **progress file**
  (`<task-file>.progress.md`, or `--progress-file <path>`; `none` disables) and is told to
  append `- done: …` after each deliverable. A resumed run reads it first and skips finished
  work — also when you resume by hand.

The output lists every `attempts[]` entry (provider, model, class, turns, duration,
session_id); top-level `provider`/`model` are the ones that produced the final result, and
`usage` / `cost_usd` are summed over all attempts. `session_id` is reported on **every**
failure, including timeout, so a dead run can always be continued with `--resume`.

Runs that die anyway are almost always **too big**. Keep a worker under ~15 minutes / ~40 turns
and split larger work into sequential packages — a lost run then costs one step, not an hour.

### Peak hours

Flat-rate plans meter **quota**, and some meter it faster at certain times. z.ai's GLM Coding
Plan counts `glm-5.3` at **3×** during peak hours — **Mon–Fri 14:00–18:00 UTC+8**, i.e.
08:00–12:00 German time — and 1× otherwise; `glm-5.3-flash` counts 1.2× vs 0.4× (per
[docs.z.ai](https://docs.z.ai/devpack/notice/usage-revision), September 2026). A provider
describes that with a `peak` block:

```jsonc
"peak": {
  "tz": "+08:00", "days": [1, 2, 3, 4, 5], "windows": ["14:00-18:00"],   // 0 = Sunday
  "quota": { "glm-5.3": { "offPeak": 1, "peak": 3 }, "glm-5.3-flash": { "offPeak": 0.4, "peak": 1.2 } },
  "maxParallel": 1,          // tighter slot limit while peak is active (optional)
  "preferFallback": false    // start runs on provider.fallback during peak (optional)
}
```

Effects: `doctor` shows whether peak is active right now; `run` prints a stderr notice, applies
`peak.maxParallel`, multiplies `cost_usd` by the model's quota factor (so the number tracks what
the plan actually charges) and reports `quota_multiplier` per attempt and at top level. With
`preferFallback` a run starts on the fallback provider (e.g. pay-per-use OpenRouter) instead of
burning 3× quota — whether that trade is worth it is your call, hence off by default.

## Usage

Most of the time the **`fleet` skill** drives this — it plans, dispatches and reviews for you
(it calls the script via `$CLAUDE_PLUGIN_ROOT`). For manual use, run the script from wherever
the plugin is checked out or installed:

```
node scripts/fleet.mjs doctor [--ping]                              # providers + key status (+ live ping)
node scripts/fleet.mjs list                                         # configured roles/providers/models
node scripts/fleet.mjs run --role coder --task "..." --cwd .        # dispatch a worker
node scripts/fleet.mjs run --role coder --resume <session_id> --task "<fix>"   # follow-up, same worker session
```

`run` also accepts `--provider <id> --model <tier|literal>` instead of `--role` (the literal
form takes any model id the provider serves, e.g. `opencode-go/kimi-k3`, even if it isn't in
the config), `--agent <name>` for opencode workers, and `--task-file <path>` (or stdin) instead
of `--task`. It returns JSON with `result`,
`session_id`, `usage`, a computed `cost_usd` when `pricing` is set, and an `attempts[]` list
(on failure also `error_class`, `retry_after_sec`, `reset_at`, `diagnostics` — see "Failure
handling"). A failed review is best handled with `--resume` (keeps context, pays only the
delta) rather than a fresh worker.

## Security

- **No secrets in the config** — it stores only env-var *names*; keys come from the environment
  or the optional `envFile`. `ANTHROPIC_BASE_URL` is never set globally, only inline in the
  worker subprocess.
- **`--allowedTools` is a permission allowlist**: anything listed runs **without a prompt**. A
  role with `Bash` therefore has effectively **full shell access** inside its `cwd`, regardless
  of `permissionMode`. Give `Bash` only to roles that genuinely need it — in the example config
  `grunt` deliberately has none. Worker edits are reviewable via `git diff`.
- **opencode workers auto-approve.** A headless worker cannot answer permission prompts, so
  `permissionMode` `acceptEdits` / `bypassPermissions` (the default is `acceptEdits`) maps to
  opencode's `--auto` — the worker approves every tool call that isn't explicitly denied,
  **including shell commands**. To restrict an opencode worker, define an opencode agent with
  denied permissions and set it on the role (`"agent": "..."`).
- **Cost accounting is our own.** The CLI's `total_cost_usd` is computed with Anthropic prices
  and is **unreliable for third-party models**, so fleet.mjs uses the config's `pricing` field
  to compute cost instead. Configure `pricing` if you want accurate numbers. On the opencode
  runner, opencode's own per-token cost figure is used as a fallback (`cost_source:
  "opencode-reported"`) — on flat-rate plans like OpenCode Go that number is notional, not
  billed.

## Compatibility

The **claude runner** (env-var approach) only works with **Anthropic-Messages-compatible**
endpoints. Pure OpenAI-format providers are covered by the **opencode runner** instead — the
opencode CLI speaks both formats natively, so no shim (claude-code-router / LiteLLM) is needed.

Confirmed-compatible:

| Provider        | Runner   | Base URL / auth                      | Notes |
|-----------------|----------|--------------------------------------|-------|
| DeepSeek        | claude   | `https://api.deepseek.com/anthropic` | |
| z.ai / GLM      | claude   | `https://api.z.ai/api/anthropic`     | |
| OpenRouter      | claude   | `https://openrouter.ai/api`          | "Anthropic skin", incl. tool-use / thinking |
| OpenCode Go/Zen | opencode | via `opencode auth` / `/connect`     | all Go models incl. OpenAI-format-only ones (`glm-5.3`, `kimi-k3`, ...) |

The model names and prices in `fleet.config.example.json` are **examples** (prices as of
July 2026), not guarantees. Run
`doctor --ping` to verify that your configured URL, auth and model names actually resolve before
you rely on them.
