# AIPilot Plugin

Multi-agent orchestration pipeline for structured, high-quality implementations.

## How It Works

This plugin orchestrates specialized AI agents through a structured pipeline:

1. **Opus** analyzes the codebase and creates a detailed implementation plan (1-5 steps)
2. **Codex** reviews the plan for correctness, completeness, and risks
3. **Opus** revises the plan based on Codex findings
4. **User** reviews the plan and can request changes (loops back through 2-3-4)
5. **For each step**: **Opus** implements the step, then **Codex** reviews it (fix loop if needed)
6. **Codex** does a final review of all changes for overall completeness
7. **Opus + Playwright** verifies UI changes visually (if applicable)

## Usage

Invoke with `/pipeline` or say "start pipeline" followed by your task description.

## Artifact Files

All pipeline artifacts are stored in `.task-{session-id}/` in the project directory (each pipeline run gets a unique 6-char hex session ID):

| File | Purpose |
|------|---------|
| `pipeline-tasks.json` | Task ID mapping (gating artifact — must exist before Task()) |
| `plan.md` | Human-readable plan (editable) |
| `plan.json` | Machine-readable plan |
| `plan-review.json` | Codex plan review results |
| `step-N-result.json` | Per-step implementation results |
| `step-N-review.json` | Per-step code review results |
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
- **Per-step implementation + review**: Each step is implemented and reviewed individually before moving on
- **Final review**: After all steps, a comprehensive review verifies overall completeness
- **Codex via MCP**: All reviews use `mcp__codex__codex` tool calls. The orchestrator builds prompts, calls Codex via MCP, parses the JSON response, writes review artifacts, and validates with `validate-review.js`
- **Playwright for UI**: Visual verification catches issues automated tests miss
- **User plan verification**: User can request plan changes, triggering Opus revision + Codex re-review before approval
- **Iteration limits**: Max 3 review loops per gate before escalating to user
- **Session isolation**: Each pipeline run gets a unique `.task-{session-id}/` directory, enabling parallel execution and preventing state collisions between concurrent pipelines
