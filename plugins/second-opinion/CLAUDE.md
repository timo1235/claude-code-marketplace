# Second Opinion Plugin

Get an independent second opinion from an alternative AI model (Codex CLI or Opus fallback) when stuck on a problem.

## How It Works

### Manual Mode
Invoke with `/second-opinion`. The skill gathers context about the current problem, writes it to `.second-opinion/context.md`, and invokes Codex CLI (or falls back to Opus) for an independent analysis. Results are presented but NOT automatically implemented.

### Automatic Mode (Advisory)
The `stuck-detector.js` hook monitors PostToolUse events for repeated errors. When the same error appears 2+ times, it suggests `/second-opinion` via advisory context. Claude decides whether to act on the suggestion.

## Files

| File | Purpose |
|------|---------|
| `.second-opinion/context.md` | Problem context for the alternative model |
| `.second-opinion/opinion.json` | Generated opinion output |
| `.second-opinion/error-state.json` | Error tracking state for stuck detection |
| `.second-opinion/.opinion.lock` | Lock file preventing concurrent Codex processes |

## Loop Prevention

- Hook is advisory only (exit 0) — never blocks
- 3-minute cooldown between automatic suggestions
- Max 3 automatic suggestions per session
- Lock file prevents parallel Codex processes
- Opinion agent is read-only (no project file modifications)

## Requirements

- Claude Code CLI
- Codex CLI (optional — falls back to Opus subagent if not available)
