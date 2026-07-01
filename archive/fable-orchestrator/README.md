# fable-orchestrator

Make **Claude Fable** an orchestrator instead of a do-everything model. Fable plans,
decomposes, reviews and integrates — and delegates the actual execution to cheaper subagents
by complexity. The goal is to stop burning the most expensive model on grunt work.

## Why

Fable ($10/$50 per 1M tokens) shines at planning, reviewing, and long coherent agentic work.
Mechanical and clearly-scoped execution doesn't need it. This plugin keeps Fable in the
orchestrator seat and pushes execution down to the cheapest tier that can do the job.

Abo-native by design: subagents run on the Anthropic tiers `haiku` / `sonnet` / `opus` (all
covered by the Max plan, no per-token cost) — no external router or third-party provider.

## What's inside

A skill (the orchestration policy) plus three execution subagents:

| Component | Tier | Role |
|---|---|---|
| `fable-orchestrate` (skill) | — | Policy: when/how Fable delegates and reviews |
| `grunt-worker` (agent) | haiku | Mechanical, clearly-specified work, no decisions |
| `task-implementer` (agent) | sonnet | Scoped implementation to a clear spec |
| `heavy-lift` (agent) | opus | Complex execution that needs real reasoning |

## Install

```
/plugin marketplace add timo1235/claude-code-marketplace
/plugin install fable-orchestrator@timo1235-marketplace
```

## Use

Run on a session whose main model is **Claude Fable**, then start a multi-step task with:

```
/fable-orchestrate
```

Fable then plans, delegates execution via the Task tool (`subagent_type: grunt-worker |
task-implementer | heavy-lift`), reviews each result, and integrates. The skill also triggers
on phrasings like "fable", "orchestrate", or "delegate work".

> Works on Opus 4.8 too (the agents just pin lower tiers) — but the token saving is largest
> when the main model is Fable.

## Notes

- **Effort / thinking** is session-wide (env), not per-subagent. Grunt subagents save via the
  cheaper *model*, not via per-agent thinking budgets. Keep Fable's own effort high
  (`high`/`xhigh`) for planning and review.
- **Cost ceiling toggle:** `CLAUDE_CODE_SUBAGENT_MODEL=haiku` in `.claude/settings.json` (`env`)
  forces *all* subagents onto one model — overrides the per-agent tiers. Use as a "cheap mode",
  not a default.
- **Swappable tiers:** the `haiku`/`sonnet`/`opus` names can be remapped to other models via
  `ANTHROPIC_DEFAULT_HAIKU_MODEL` / `_SONNET_MODEL` / `_OPUS_MODEL` — but cross-provider routing
  (e.g. DeepSeek) needs a gateway and disables the Max plan, so it's intentionally not bundled here.
