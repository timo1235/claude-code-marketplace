# subagent-fleet

Run your **orchestrator** on an expensive frontier model (Fable, Opus, GPT-5, ...) and push the
actual **execution** down to cheaper, Anthropic-compatible third-party providers — z.ai/GLM,
DeepSeek, OpenRouter. The orchestrator plans, decomposes, delegates and reviews; the workers do
the mechanical, clearly-scoped work. Which providers, models and roles the workers use is pure
**configuration** — drop in credentials, define models, done. Not tied to any one shell config,
not tied to Fable, not tied to an Anthropic subscription.

## How it works

The built-in Task tool **inherits the parent process's backend** (`ANTHROPIC_BASE_URL` /
`ANTHROPIC_AUTH_TOKEN`). A running session has exactly one backend, and the only per-subagent
knob is the *model name* that this one backend serves — so the Task tool **cannot** send a
subagent to z.ai while the orchestrator stays on Anthropic.

So instead, for each delegated task the orchestrator runs a separate **headless `claude -p`
process** with provider-specific env vars. Each worker is its own Claude Code instance,
authenticated against the third-party provider; the Anthropic auth is stripped from the worker's
env. The result (including token usage and a `session_id` for follow-ups) comes back as JSON,
and the orchestrator reviews it.

Workers run **isolated** by default: no user/project settings, no plugins, no hooks, no MCP
servers. This keeps your local config out of every worker and avoids re-spawning MCP servers per
dispatch. (Overridable in config if you actually need project settings inside a worker.)

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
    }
    // ... zai, openrouter, ...
  },

  "roles": {
    // provider: which provider; model: a tier name (strong/default/fast) or a literal model id;
    // tools: the worker's allowed-tools allowlist
    "coder":      { "provider": "zai",      "model": "strong", "tools": "Read,Edit,Write,Grep,Glob,Bash" },
    "researcher": { "provider": "deepseek", "model": "fast",   "tools": "Read,Grep,Glob,WebFetch" },
    "grunt":      { "provider": "deepseek", "model": "fast",   "tools": "Read,Edit,Write,Grep,Glob" }
  },

  "defaults": { "permissionMode": "acceptEdits", "maxTurns": 40, "timeoutSec": 1800 }
}
```

- **providers** — each has a `baseUrl` (Anthropic-Messages-compatible endpoint), an `apiKeyEnv`
  (the env-var *name*), a `smallFastModel` (Claude Code makes internal Haiku-class calls; on a
  third-party backend the default Claude model name fails, so this one is used instead), a
  `models` map with the `strong` / `default` / `fast` tiers, and optional `pricing` per model.
- **roles** — a named worker profile: which `provider`, which `model` (a tier name or a literal
  model id), and the `tools` allowlist.
- **defaults** — `permissionMode`, `maxTurns`, and the hard-kill `timeoutSec` (default 30 min).
  Optionally `settingSources` (default `""` = fully isolated worker) if you need user/project
  settings inside workers.

## Usage

Most of the time the **`fleet` skill** drives this — it plans, dispatches and reviews for you
(it calls the script via `$CLAUDE_PLUGIN_ROOT`). For manual use, run the script from wherever
the plugin is checked out or installed:

```
node scripts/fleet.mjs doctor [--ping]                              # providers + key status (+ live ping)
node scripts/fleet.mjs list                                         # configured roles/providers/models
node scripts/fleet.mjs run --role coder --task "..." --cwd .        # dispatch a worker
node scripts/fleet.mjs run --resume <session_id> --task "<fix>"     # follow-up on the same worker session
```

`run` also accepts `--provider <id> --model <tier|literal>` instead of `--role`, and
`--task-file <path>` (or stdin) instead of `--task`. It returns JSON with `result`,
`session_id`, `usage`, and a computed `cost_usd` when `pricing` is set. A failed review is best
handled with `--resume` (keeps context, pays only the delta) rather than a fresh worker.

## Security

- **No secrets in the config** — it stores only env-var *names*; keys come from the environment
  or the optional `envFile`. `ANTHROPIC_BASE_URL` is never set globally, only inline in the
  worker subprocess.
- **`--allowedTools` is a permission allowlist**: anything listed runs **without a prompt**. A
  role with `Bash` therefore has effectively **full shell access** inside its `cwd`, regardless
  of `permissionMode`. Give `Bash` only to roles that genuinely need it — in the example config
  `grunt` deliberately has none. Worker edits are reviewable via `git diff`.
- **Cost accounting is our own.** The CLI's `total_cost_usd` is computed with Anthropic prices
  and is **unreliable for third-party models**, so fleet.mjs uses the config's `pricing` field
  to compute cost instead. Configure `pricing` if you want accurate numbers.

## Compatibility

The env-var approach only works with **Anthropic-Messages-compatible** endpoints. Pure
OpenAI-format providers need a shim (claude-code-router / LiteLLM) and are intentionally **not
part of v1**.

Confirmed-compatible providers:

| Provider   | Base URL                             | Compatible |
|------------|--------------------------------------|------------|
| DeepSeek   | `https://api.deepseek.com/anthropic` | yes |
| z.ai / GLM | `https://api.z.ai/api/anthropic`     | yes |
| OpenRouter | `https://openrouter.ai/api`          | yes ("Anthropic skin", incl. tool-use / thinking) |

The model names and prices in `fleet.config.example.json` are **examples** (prices as of
July 2026), not guarantees. Run
`doctor --ping` to verify that your configured URL, auth and model names actually resolve before
you rely on them.
