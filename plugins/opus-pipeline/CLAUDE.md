# Opus Pipeline Plugin

Multi-AI orchestration pipeline for structured, high-quality implementations.

## How It Works

This plugin orchestrates specialized AI agents through a structured pipeline:

1. **Opus** analyzes the codebase and creates a detailed implementation plan
2. **Codex** reviews the plan for correctness, completeness, and risks
3. **Opus** revises the plan based on Codex findings
4. **User** reviews the plan and can request changes (loops back through 2-3-4)
5. **Opus** implements the plan step by step
6. **Codex** reviews the implementation
7. **Opus + Playwright** verifies UI changes visually (if applicable)

## Usage

Invoke with `/pipeline` or say "start pipeline" followed by your task description.

## Artifact Files

All pipeline artifacts are stored in `.task/` in the project directory:

| File | Purpose |
|------|---------|
| `state.json` | Current pipeline state |
| `pipeline-tasks.json` | Task ID mapping |
| `plan.md` | Human-readable plan (editable) |
| `plan.json` | Machine-readable plan |
| `plan-review.json` | Codex plan review results |
| `impl-result.json` | Implementation results |
| `code-review.json` | Codex code review results |
| `user-plan-feedback.json` | User plan review feedback |
| `ui-review.json` | Playwright UI verification results |

## Agent Definitions

See `AGENTS.md` for detailed agent specifications.

## Architecture Decisions

- **Task-based enforcement**: Uses `blockedBy` dependencies to enforce execution order
- **Markdown plan file**: User can directly edit `.task/plan.md` before approval
- **Codex as gate**: Both plan and code must pass Codex review
- **Playwright for UI**: Visual verification catches issues automated tests miss
- **User plan verification**: User can request plan changes, triggering Opus revision + Codex re-review before approval
- **Iteration limits**: Max 3 review loops before escalating to user
