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
│  Output: .task/plan.md + .task/plan.json (1-5 steps)             │
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
│  Phase 5: STEP-BY-STEP IMPLEMENTATION + PER-STEP REVIEW          │
│                                                                  │
│  For each step N (1 to total_steps):                             │
│  ┌───────────────────────────────────────────────────────┐       │
│  │  5a: Implement Step N                                  │       │
│  │  Agent: implementer (Opus) with step_id: N             │       │
│  │  Output: .task/step-N-result.json                      │       │
│  │                     │                                  │       │
│  │                     ▼                                  │       │
│  │  5b: Review Step N                                     │       │
│  │  Tool: Codex CLI with step_id: N                       │       │
│  │  Output: .task/step-N-review.json                      │       │
│  │                     │                                  │       │
│  │       ┌─────────────┼──────────────┐                   │       │
│  │       ▼             ▼              │                   │       │
│  │  ┌─────────┐  ┌──────────────┐    │                   │       │
│  │  │approved │  │ needs_changes│    │                   │       │
│  │  └────┬────┘  └──────┬───────┘    │                   │       │
│  │       │              │            │                   │       │
│  │       │              ▼            │                   │       │
│  │       │     Fix + Re-review       │                   │       │
│  │       │     (max 3 iterations)    │                   │       │
│  └───────┼───────────────────────────┘                   │       │
│          │                                                       │
│          ▼ Next step (or done)                                   │
│                                                                  │
│  After all steps: write .task/impl-result.json (summary)         │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 6: FINAL CODE REVIEW                                      │
│  Tool: Codex CLI with step_id: "final"                           │
│  Reviews ALL changes, verifies overall plan completeness         │
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
| Per-Step Code Review | 3 per step | Escalate to user |
| Final Code Review | 3 | Escalate to user |
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
| `step-N-result.json` | Implementer | 5a (per step) |
| `step-N-review.json` | Codex | 5b (per step) |
| `impl-result.json` | Orchestrator | 5 (summary) |
| `code-review.json` | Codex | 6 |
| `ui-review.json` | UI Verifier | 7 |
| `screenshots/*.png` | UI Verifier | 7 |
| `codex_stderr.log` | Codex wrapper | 2, 5b, 6 |
