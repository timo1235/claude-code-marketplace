# AIPilot Plugin

Multi-agent orchestration pipeline for structured, high-quality implementations.

## How It Works

This plugin orchestrates specialized AI agents through a structured pipeline:

1. **User** selects the review model (Codex/Opus/Sonnet) at pipeline start
2. **Opus** analyzes the codebase and creates a detailed implementation plan (1-5 steps)
3. **Codex** reviews the plan once for correctness, completeness, and risks
4. **Opus** revises the plan based on Codex findings (if needed, no re-review)
5. **User** reviews the plan and can request changes (Opus revises, no Codex re-review)
6. **Opus** implements all steps sequentially (no per-step reviews)
7. **Codex** does a single final review of all changes for overall completeness
8. **Opus + Playwright** verifies UI changes visually (if applicable)

## Usage

Invoke with `/pipeline` or say "start pipeline" followed by your task description.

## Artifact Files

All pipeline artifacts are stored in `.task-{session-id}/` in the project directory (each pipeline run gets a unique 6-char hex session ID):

| File | Purpose |
|------|---------|
| `pipeline-config.json` | Pipeline mode and review model selection |
| `pipeline-tasks.json` | Task ID mapping (gating artifact — must exist before Task()) |
| `plan.md` | Human-readable plan (editable) |
| `plan.json` | Machine-readable plan |
| `plan-review.json` | Codex plan review results (single review) |
| `step-N-result.json` | Per-step implementation results |
| `impl-result.json` | Combined implementation results (all steps) |
| `code-review.json` | Final code review results (all changes) |
| `user-plan-feedback.json` | User plan review feedback |
| `ui-review.json` | Playwright UI verification results |

## Agent Definitions

See `AGENTS.md` for detailed agent specifications.

## Session Isolation

- Each pipeline run creates a unique session directory `.task-{session-id}/` (e.g. `.task-a1b2c3/`)
- Session ID is a 6-character hex string generated during `orchestrator.sh init`
- Multiple pipelines can run in parallel on the same project without conflicts
- Use `orchestrator.sh status --session-id <id>` to check a specific session
- Use `orchestrator.sh reset --all` to clean up all sessions
- Hooks auto-discover the latest active session or use the `AIPILOT_SESSION_ID` env var

## Architecture Decisions

- **Task-based enforcement**: Uses `blockedBy` dependencies to enforce execution order
- **Markdown plan file**: User can directly edit `plan.md` in the session directory before approval
- **1-5 step plans**: Complexity-based step count keeps plans focused and reviewable
- **Sequential implementation**: Steps are implemented sequentially without per-step reviews
- **Single final review**: After all steps, one comprehensive Codex review verifies overall completeness
- **User-selected review model**: User chooses the review model at pipeline start — Codex (gpt-5 via MCP), Opus (Claude Task agent), or Sonnet (Claude Task agent)
- **Codex via MCP**: All reviews use `mcp__codex__codex` tool calls. The orchestrator builds prompts, calls Codex via MCP, parses the JSON response, writes review artifacts, and validates with `validate-review.js`
- **Playwright for UI**: Visual verification catches issues automated tests miss
- **User plan verification**: User can request plan changes, triggering Opus revision (without Codex re-review)
- **Iteration limits**: Max 3 review loops per gate before escalating to user
- **Session isolation**: Each pipeline run gets a unique `.task-{session-id}/` directory, enabling parallel execution and preventing state collisions between concurrent pipelines
