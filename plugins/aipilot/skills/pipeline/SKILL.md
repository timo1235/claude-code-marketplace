---
name: pipeline
description: Start the multi-AI pipeline. Opus analyzes and plans, Codex reviews the plan, User approves via markdown file, Opus implements iteratively, Codex does final code review, Playwright verifies UI changes. Use when the user says "pipeline", "start pipeline", "aipilot", "start aipilot", "ai pilot", "nutze aipilot", "plan and implement", or wants a structured multi-step implementation workflow.
plugin-scoped: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task, AskUserQuestion, TaskCreate, TaskUpdate, TaskList, TaskGet, WebSearch, WebFetch, mcp__plugin_playwright_playwright__browser_snapshot, mcp__plugin_playwright_playwright__browser_take_screenshot, mcp__plugin_playwright_playwright__browser_navigate, mcp__plugin_playwright_playwright__browser_click, mcp__plugin_playwright_playwright__browser_fill_form
---

# Pipeline Orchestrator

**CRITICAL RULE — READ THIS FIRST:**
You MUST execute the entire pipeline as one continuous sequence. After EVERY phase, you IMMEDIATELY proceed to the next — no summarizing, no asking the user, no pausing. The ONLY exception is Phase 4 (User Review). If you catch yourself about to write a summary and wait, STOP and call the next tool instead.

**FORBIDDEN behaviors (violating these breaks the pipeline):**
- NEVER output a summary after Phase 1 and ask the user what to do
- NEVER say "Soll ich..." or "Shall I..." or "Die Analyse ist abgeschlossen" and wait
- NEVER skip creating the task chain at startup
- NEVER stop between phases except Phase 4
- NEVER write code or analyze the codebase yourself — delegate to agents
- NEVER pass plain-text parameters to agents — use XML tags

## Initialization

Do ALL of the following before starting the main loop:

**0a.** If the user did not provide a task description, use `AskUserQuestion` to get it. Otherwise continue.

**0b.** Find the plugin root:
```
Bash("find / -path '*/aipilot/scripts/codex-review.js' -type f 2>/dev/null | head -1")
```
Strip `/scripts/codex-review.js` from the result → this is `<PLUGIN_ROOT>`. The project directory is the current working directory → `<PROJECT_DIR>`.

**0c.** Run Codex preflight:
```
Bash("node <PLUGIN_ROOT>/scripts/codex-review.js --type preflight")
```
- Exit 0 + `"ok": true` → continue
- Any failure → ABORT. Tell user: "Codex CLI not available. Pipeline requires Codex. Please install and retry."

**0d.** Create `.task/` directory:
```
Bash("mkdir -p <PROJECT_DIR>/.task")
```

**0e.** Create the full task chain — you MUST do this NOW:
```
TaskCreate({ subject: "Phase 1: Analyze codebase and create plan", description: "...", activeForm: "Analyzing codebase" })
TaskCreate({ subject: "Phase 2: Codex plan review", description: "...", activeForm: "Running Codex plan review" })
TaskCreate({ subject: "Phase 3: Revise plan (if needed)", description: "...", activeForm: "Revising plan" })
TaskCreate({ subject: "Phase 4: User review of plan", description: "...", activeForm: "Waiting for user review" })
```
Then set dependencies with `TaskUpdate`:
- T2 blockedBy T1
- T3 blockedBy T2
- T4 blockedBy T3

**→ NOW enter the Main Loop.**

## Main Loop

Execute this loop until all tasks are completed or the pipeline is aborted:

```
1. TaskList() → find the first task where:
   - status is "pending"
   - blockedBy is empty or all blockedBy tasks are "completed"
2. If no such task exists AND all tasks are "completed" → pipeline is done, go to Completion
3. If no such task exists AND some tasks are blocked → error state, report to user
4. TaskUpdate(task_id, status: "in_progress")
5. Execute the task (see Task Execution Reference below)
6. Handle the result (may create new tasks, may loop)
7. TaskUpdate(task_id, status: "completed")
8. → Go back to step 1
```

**Key rule:** `blockedBy` is data, not an instruction. `TaskList()` shows blocked tasks — only claim tasks where blockedBy is empty or all dependencies are completed.

## Task Execution Reference

### Phase 1: Analyze & Plan

Launch the analyzer agent:
```
Task({
  subagent_type: "aipilot:analyzer",
  model: "opus",
  prompt: "<task_description>\n{USER_TASK}\n</task_description>\n\nProject directory: <PROJECT_DIR>",
  description: "Analyze and plan"
})
```

When the agent returns, mark complete. Do NOT summarize. Do NOT tell the user what the analyzer found. The Main Loop will immediately pick up Phase 2.

### Phase 2: Codex Plan Review

Run Codex:
```
Bash("node <PLUGIN_ROOT>/scripts/codex-review.js --type plan --plugin-root <PLUGIN_ROOT> --project-dir <PROJECT_DIR>")
```

Read `.task/plan-review.json`. Handle based on status:

- `status: "approved"` → Mark Phase 2 complete. Also mark Phase 3 as `completed` (skipped — no revision needed).
- `status: "needs_changes"` → Mark Phase 2 complete. Phase 3 will pick up the revision.
- `status: "needs_clarification"` → Read `clarification_questions`, ask user with `AskUserQuestion`, write answers to `.task/user-plan-feedback.json`. Mark Phase 2 complete, Phase 3 will incorporate.
- `status: "rejected"` → Escalate to user.

Track iteration count. Max 3 plan review iterations before escalating to user.

### Phase 3: Plan Revision

Launch analyzer with review findings:
```
Task({
  subagent_type: "aipilot:analyzer",
  model: "opus",
  prompt: "<task_description>\n{USER_TASK}\n</task_description>\n\n<review_findings>\n{FINDINGS_FROM_PLAN_REVIEW}\n</review_findings>\n\nProject directory: <PROJECT_DIR>",
  description: "Revise plan"
})
```

After revision, create a NEW Phase 2 task (re-review) and a NEW Phase 3 task (potential re-revision), with appropriate blockedBy. This creates the review loop through the task chain, not through imperative GOTO.

### Phase 4: User Review (ONLY STOP POINT)

This is the ONE place you stop and ask the user.

Tell the user: "The plan is ready for review at `.task/plan.md`."

Use `AskUserQuestion`:
- "Plan approved" → Mark complete. Create implementation tasks (see Phase 5 setup below).
- "I want changes" → Ask what should change, write to `.task/user-plan-feedback.json`, create new revision + review tasks, loop via Main Loop. Max 3 user iterations.
- "Cancel pipeline" → Stop.

### Phase 5 Setup: Create Implementation Tasks

Read `.task/plan.json` to get `total_steps`. Create per-step tasks:
```
For each step N (1..total_steps):
  TaskCreate({ subject: "Phase 5a: Implement step N - [title]", ... })  → T-impl-N
  TaskCreate({ subject: "Phase 5b: Review step N", ... })               → T-review-N, blockedBy T-impl-N
TaskCreate({ subject: "Phase 6: Final review", ... })                   → blockedBy last T-review-N
TaskCreate({ subject: "Phase 7: UI verification", ... })                → blockedBy Phase 6
```

Then return to the Main Loop — it will pick up the first unblocked implementation task.

### Phase 5a: Implement Step N

Extract step number from the task subject. Launch implementer:
```
Task({
  subagent_type: "aipilot:implementer",
  model: "opus",
  prompt: "<step_id>\nN\n</step_id>\n\nProject directory: <PROJECT_DIR>",
  description: "Implement step N"
})
```

### Phase 5b: Review Step N

Run Codex:
```
Bash("node <PLUGIN_ROOT>/scripts/codex-review.js --type step-review --step-id N --plugin-root <PLUGIN_ROOT> --project-dir <PROJECT_DIR>")
```

Read `.task/step-N-review.json`:
- `approved` → Mark complete. Main Loop continues to next step.
- `needs_changes` → Create new impl task (with `<fix_findings>`) + new review task (with `--resume --changes-summary`), blockedBy the new impl task. Max 3 iterations per step.
- `rejected` → Escalate to user.

### Phase 5 Completion

After ALL step review tasks are completed, write `.task/impl-result.json`:
```json
{
  "status": "complete",
  "has_ui_changes": true/false,
  "total_steps": N,
  "steps_completed": [...],
  "files_changed": [...]
}
```

### Phase 6: Final Review

Run Codex:
```
Bash("node <PLUGIN_ROOT>/scripts/codex-review.js --type final-review --plugin-root <PLUGIN_ROOT> --project-dir <PROJECT_DIR>")
```

- `approved` → Mark complete. Main Loop picks up Phase 7.
- `needs_changes` → Create new impl fix task + new final review task. Max 3 iterations.

### Phase 7: UI Verification (conditional)

Only if `has_ui_changes: true` in `.task/impl-result.json`. Otherwise mark as `completed` immediately.

Launch UI verifier:
```
Task({
  subagent_type: "aipilot:ui-verifier",
  model: "opus",
  prompt: "<verification_scope>\n{WHAT_TO_VERIFY}\n</verification_scope>\n\nProject directory: <PROJECT_DIR>",
  description: "Verify UI changes"
})
```

If issues found → fix and re-verify. Max 2 iterations.

### Completion

When the Main Loop finds no pending/unblocked tasks and all tasks are completed:

NOW you may summarize all changes to the user and report final status.

## Pipeline Overview (Reference)

```
Phase 1: Analyze & Plan       (Opus)      → .task/plan.md + .task/plan.json (1-5 steps)
Phase 2: Plan Review           (Codex)     → .task/plan-review.json
Phase 3: Plan Revision         (Opus)      → Updated .task/plan.md (if needed)
Phase 4: User Review           (Manual)    → User reviews/edits plan, loops through 2-3-4
Phase 5: Step-by-Step Implementation + Per-Step Review
          For each step N:
            5a: Implement Step N  (Opus)    → .task/step-N-result.json
            5b: Review Step N     (Codex)   → .task/step-N-review.json
            (fix loop if needed, max 3 iterations per step)
Phase 6: Final Review          (Codex)     → .task/code-review.json (all changes)
Phase 7: UI Verification       (Opus)      → .task/ui-review.json (if UI changes)
```

## State Management

Update `.task/state.json` after each phase transition:
```json
{
  "phase": "implementing_step_2",
  "plan_approved": true,
  "implementation_complete": false,
  "code_review_passed": false,
  "ui_review_passed": false,
  "has_ui_changes": false,
  "iteration": 0,
  "current_step": 2,
  "total_steps": 3
}
```

Phase values: `analyzing`, `plan_review`, `plan_revision`, `user_review`, `implementing_step_N`, `reviewing_step_N`, `final_review`, `ui_verification`, `complete`.

## impl-result.json Format

After ALL steps complete, write `.task/impl-result.json`:
```json
{
  "status": "complete",
  "has_ui_changes": true,
  "total_steps": 3,
  "steps_completed": [],
  "files_changed": []
}
```

<rules>

## Rules

### Iteration Limits
- Max 3 plan review iterations before escalating to user
- Max 3 user plan review iterations before escalating to user
- Max 3 per-step code review iterations (per step) before escalating to user
- Max 3 final code review iterations before escalating to user
- Max 2 UI fix iterations before escalating to user
- Always show the user what failed and why

### Error Handling
- If any agent fails → report the error, ask user how to proceed
- If Codex is unavailable → **ABORT the pipeline** (Codex is required, verified by preflight check)
- If Playwright is unavailable → skip UI verification, warn user
- If codex-review.js returns an error JSON in the output file → read the error, report to user, do not retry blindly

### Agent Communication
- ALWAYS wrap agent input in the XML tags the agent expects: `<task_description>`, `<step_id>`, `<fix_findings>`, `<review_findings>`, `<verification_scope>`
- NEVER pass plain-text parameters
- NEVER write code or analyze the codebase yourself — delegate to agents
- NEVER stop between phases except at Phase 4 (User Review)
- NEVER summarize intermediate results — just proceed via the Main Loop

### Codex Review Flags
- `--plugin-root <PLUGIN_ROOT>` — always pass for schema/standards resolution
- `--resume` — use when re-reviewing after fixes
- `--changes-summary "..."` — use with --resume for focused re-reviews

### Exit Codes (codex-review.js)
- `0` = success
- `1` = validation error
- `2` = Codex error
- `3` = timeout

</rules>
