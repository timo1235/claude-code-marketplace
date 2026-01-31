# Second Opinion Plugin

Get an independent second opinion from an alternative AI model when you're stuck on a problem.

## Features

- **Manual trigger**: `/second-opinion` collects context, invokes Codex CLI or Opus, presents analysis
- **Automatic detection**: Hook detects repeated errors and suggests getting a second opinion
- **Codex + Opus**: Prefers Codex CLI for independence, falls back to Opus subagent
- **Non-invasive**: Only presents suggestions, never automatically implements changes

## Installation

```
claude plugin install second-opinion@timo1235-marketplace
```

## Usage

When stuck on a problem, type:

```
/second-opinion
```

The plugin will:
1. Gather context about your current problem
2. Send it to an alternative AI model (Codex CLI or Opus)
3. Present independent analysis with alternative approaches

### Automatic Suggestions

The plugin automatically monitors for repeated errors. When the same error appears 2+ times, you'll see:

```
[SECOND-OPINION] Same error detected 2 times. Consider /second-opinion for a fresh perspective.
```

## Requirements

- Claude Code CLI
- Codex CLI (optional, recommended — falls back to Opus if unavailable)

## How It Works

### Architecture

```
/second-opinion (Skill)
  → gathers context → writes .second-opinion/context.md
  → runs get-opinion.js
    → Codex available? → codex exec with schema → opinion.json
    → No Codex? → exit 10 → Opus subagent fallback → opinion.json
  → presents formatted results

PostToolUse Hook (stuck-detector.js)
  → extracts error signatures from tool results
  → tracks in .second-opinion/error-state.json
  → same error 2x + cooldown passed → advisory suggestion
```

### Loop Prevention

| Mechanism | Purpose |
|-----------|---------|
| Advisory hook (exit 0) | Claude decides, not forced |
| 3-minute cooldown | No spam between suggestions |
| Max 3 suggestions/session | Hard limit on auto-suggestions |
| Lock file | Prevents concurrent Codex processes |
| Read-only agent | Opinion agent can't create new errors |

## License

MIT
