# Pipeline Workflow

## Phase Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     User invokes /pipeline                       │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 1: ANALYZE                                                │
│  Agent: analyzer (Opus)                                          │
│  Output: .task/plan.md + .task/plan.json                         │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 2: PLAN REVIEW                                            │
│  Tool: Codex CLI (via codex-review.js)                           │
│  Output: .task/plan-review.json                                  │
│                                                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────┐               │
│  │  approved    │  │ needs_changes│  │ rejected │               │
│  └──────┬──────┘  └──────┬───────┘  └────┬─────┘               │
│         │                │               │                       │
│         │                ▼               ▼                       │
│         │     Phase 3: REVISION    Escalate to User             │
│         │     (max 3 iterations)                                 │
│         │         │                                              │
│         │         └──► Back to Phase 2                           │
└─────────┼───────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 4: USER REVIEW                                            │
│  User reads/edits .task/plan.md                                  │
│  Options: Approve | I want changes | Cancel                      │
│  Output: .task/user-plan-feedback.json (if changes wanted)       │
│                                                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────┐               │
│  │  approved    │  │ want changes │  │  cancel  │               │
│  └──────┬──────┘  └──────┬───────┘  └────┬─────┘               │
│         │                │               │                       │
│         │                ▼               ▼                       │
│         │     Opus revises plan +    Stop Pipeline               │
│         │     Codex re-reviews +                                 │
│         │     User re-verifies                                   │
│         │     (max 3 iterations)                                 │
└─────────┼───────────────────────────────────────────────────────┘
          │ approved
          ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 5: IMPLEMENTATION                                         │
│  Agent: implementer (Opus)                                       │
│  Input: .task/plan.json                                          │
│  Output: Code changes + .task/impl-result.json                   │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 6: CODE REVIEW                                            │
│  Tool: Codex CLI (via codex-review.js)                           │
│  Output: .task/code-review.json                                  │
│                                                                  │
│  ┌─────────────┐  ┌──────────────┐                              │
│  │  approved    │  │ needs_changes│──► Fix + Re-review           │
│  └──────┬──────┘  └──────────────┘   (max 3 iterations)         │
└─────────┼───────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 7: UI VERIFICATION (conditional)                          │
│  Only if has_ui_changes == true                                  │
│  Agent: ui-verifier (Opus + Playwright MCP)                      │
│  Output: .task/ui-review.json + .task/screenshots/               │
│                                                                  │
│  ┌─────────────┐  ┌──────────────┐                              │
│  │  approved    │  │ needs_changes│──► Fix + Re-verify           │
│  └──────┬──────┘  └──────────────┘   (max 2 iterations)         │
└─────────┼───────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────┐
│                      PIPELINE COMPLETE                           │
│  Summary of all changes presented to user                        │
└─────────────────────────────────────────────────────────────────┘
```

## Iteration Limits

| Phase | Max Iterations | On Exhaustion |
|-------|---------------|---------------|
| Plan Review | 3 | Escalate to user |
| User Plan Review | 3 | Escalate to user |
| Code Review | 3 | Escalate to user |
| UI Verification | 2 | Escalate to user |

## Artifact Files

All stored in `.task/` directory:

| File | Created By | Phase |
|------|-----------|-------|
| `state.json` | Orchestrator | All |
| `pipeline-tasks.json` | Orchestrator | Init |
| `plan.md` | Analyzer | 1, 3 |
| `plan.json` | Analyzer | 1, 3 |
| `plan-review.json` | Codex | 2 |
| `user-plan-feedback.json` | Orchestrator | 4 |
| `impl-result.json` | Implementer | 5 |
| `code-review.json` | Codex | 6 |
| `ui-review.json` | UI Verifier | 7 |
| `screenshots/*.png` | UI Verifier | 7 |
| `codex_stderr.log` | Codex wrapper | 2, 6 |
