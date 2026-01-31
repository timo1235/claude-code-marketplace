# Second Opinion Plugin

Get an independent second opinion from an alternative AI model when you're stuck on a problem.

## Features

- **Manual trigger**: `/second-opinion` collects context, invokes Codex CLI or Opus, presents analysis
- **Automatic detection**: Hook detects repeated errors and suggests getting a second opinion
- **Codex + Opus**: Prefers Codex CLI for independence, falls back to Opus subagent
- **Non-invasive**: Only presents suggestions, never automatically implements changes
- **No project clutter**: All temp files go to system temp directory and are cleaned up automatically

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
2. Pipe it to Codex CLI (or Opus) for independent analysis
3. Present the results directly — no files left behind

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
  → gathers context from conversation + codebase
  → pipes context via stdin to get-opinion.js
    → Codex available? → codex exec (temp files in /tmp, cleaned up) → JSON on stdout
    → No Codex? → exit 10 → Opus subagent with context in prompt → JSON in response
  → presents formatted results

PostToolUse Hook (stuck-detector.js)
  → extracts error signatures from tool results
  → tracks state in /tmp (no project files)
  → same error 2x + cooldown passed → advisory suggestion
```

### Loop Prevention

| Mechanism | Purpose |
|-----------|---------|
| Advisory hook (exit 0) | Claude decides, not forced |
| 3-minute cooldown | No spam between suggestions |
| Max 3 suggestions/30min | Auto-resetting limit on suggestions |
| Atomic lock file | Prevents concurrent Codex processes |
| Read-only agent | Opinion agent can't create new errors |

## License

MIT
