# Second Opinion Plugin

Get an independent second opinion from an alternative AI model (Codex via MCP or Opus fallback) when stuck on a problem.

## How It Works

### Manual Mode
Invoke with `/second-opinion`. The skill gathers context about the current problem, calls Codex via MCP (mcp__codex__codex), extracts JSON from the response, and validates it using validate-opinion.js. If Codex is unavailable, it falls back to an Opus subagent with the context in the prompt. Results are presented but NOT automatically implemented.

No files are written to the project directory. All data flows through MCP tool calls and stdin/stdout pipes.

### Automatic Mode (Advisory)
The `stuck-detector.js` hook monitors PostToolUse events for repeated errors. When the same error appears 2+ times, it suggests `/second-opinion` via advisory context. Claude decides whether to act on the suggestion. Error state is tracked in `os.tmpdir()`, not in the project.

## Loop Prevention

- Hook is advisory only (exit 0) — never blocks
- 3-minute cooldown between automatic suggestions
- Max 3 automatic suggestions per 30-minute window (auto-resets)
- Opinion agent is read-only (no project file modifications)

## Requirements

- Claude Code CLI
- Codex MCP server (configured via .mcp.json, optional — falls back to Opus subagent if not available)
