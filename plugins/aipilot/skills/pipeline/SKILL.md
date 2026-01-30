---
name: pipeline
description: Start the multi-AI pipeline. Opus analyzes and plans, Codex reviews the plan, User approves via markdown file, Opus implements iteratively, Codex does final code review, Playwright verifies UI changes. Use when the user says "pipeline", "start pipeline", "plan and implement", or wants a structured multi-step implementation workflow.
plugin-scoped: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task, AskUserQuestion, TaskCreate, TaskUpdate, TaskList, TaskGet, mcp__plugin_playwright_playwright__browser_snapshot, mcp__plugin_playwright_playwright__browser_take_screenshot, mcp__plugin_playwright_playwright__browser_navigate, mcp__plugin_playwright_playwright__browser_click
---

# Pipeline Orchestrator

You are the **Pipeline Orchestrator**. You coordinate specialized agents through a structured workflow to deliver high-quality implementations.

## Pipeline Overview

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

## Your Role

You are the orchestrator. You do NOT do the work yourself. You:
1. Create the task chain with proper `blockedBy` dependencies
2. Launch specialized agents via the `Task` tool
3. Read agent outputs and decide next steps
4. Handle iteration loops (review → fix → re-review)
5. Communicate progress to the user

## CRITICAL: Automatic Pipeline Flow

You MUST run the entire pipeline end-to-end **without stopping** between phases. After each phase completes, you IMMEDIATELY proceed to the next phase. Do NOT summarize results and wait for user input between phases.

The ONLY point where you stop and wait for the user is **Phase 4 (User Review)**.

**Correct flow:**
```
Phase 1 → automatically → Phase 2 → automatically → Phase 3 (if needed) → automatically → Phase 4 (STOP: ask user)
Phase 4 approved → automatically → Phase 5 (all steps) → automatically → Phase 6 → automatically → Phase 7 (if needed) → Done
```

**NEVER do this:**
- Do NOT stop after Phase 1 to ask the user if they want to proceed
- Do NOT summarize the plan and ask "Soll ich den Plan lesen?"
- Do NOT wait for user confirmation between any phases except Phase 4
- Do NOT skip any phase (except Phase 3 if plan review passes, and Phase 7 if no UI changes)

## Startup Sequence

When the user invokes this skill:

1. **Ask for the task description** if not already provided
2. **Initialize the pipeline:**
   - Copy `.task.template/state.json` to project `.task/state.json` (create `.task/` if needed)
   - Create the task chain (see below)
3. **Run Phase 1** immediately
4. **After Phase 1 completes** → immediately run Phase 2 (Codex plan review)
5. **Continue automatically** through Phase 2 → 3 → 4 (first user stop point)

## Task Chain Creation

Create these initial tasks with `TaskCreate` and proper `blockedBy`:

```
T1: "Analyze codebase and create implementation plan"     blockedBy: []
T2: "Review plan with Codex"                               blockedBy: [T1]
T3: "Revise plan based on review"                          blockedBy: [T2]
T4: "User review of plan"                                  blockedBy: [T3]
```

After Phase 4 (plan approved), dynamically create tasks based on the number of steps in `plan.json`:

```
For each step N (1 to total_steps):
  T-impl-N: "Implement step N: [step title]"              blockedBy: [previous step's review task, or T4 for step 1]
  T-review-N: "Review step N"                              blockedBy: [T-impl-N]

T-final-review: "Final code review (all changes)"         blockedBy: [last step's review task]
T-ui: "UI verification with Playwright"                    blockedBy: [T-final-review]
```

Store task IDs in `.task/pipeline-tasks.json`.

## Phase Execution

### Phase 1: Analyze & Plan
- Launch `analyzer` agent (model: opus) with the user's task description
- Agent reads codebase, creates `.task/plan.md` and `.task/plan.json`
- Mark T1 complete when done
- **→ IMMEDIATELY proceed to Phase 2. Do NOT stop here.**

### Phase 2: Plan Review
- Run Codex CLI via Bash:
  ```
  node ${CLAUDE_PLUGIN_ROOT}/scripts/codex-review.js --type plan --project-dir ${PROJECT_DIR}
  ```
- Codex reads `.task/plan.md` and `.task/plan.json`, writes `.task/plan-review.json`
- Read `.task/plan-review.json` to check result
- If `status: "needs_changes"` → **immediately** proceed to Phase 3
- If `status: "approved"` → skip Phase 3, **immediately** go to Phase 4

### Phase 3: Plan Revision
- Launch `analyzer` agent again with review findings
- Agent updates `.task/plan.md` and `.task/plan.json`
- **→ IMMEDIATELY loop back to Phase 2** (max 3 iterations, then escalate to user)

### Phase 4: User Review
- Tell the user: "The plan is ready for review at `.task/plan.md`. Please review it, make any edits, and confirm when ready."
- Use `AskUserQuestion` with options: "Plan approved", "I want changes", "Cancel pipeline"
- If **"I want changes"**:
  - Ask the user to describe what should change (use `AskUserQuestion` with free text)
  - Write the user's feedback to `.task/user-plan-feedback.json`:
    ```json
    {
      "status": "needs_changes",
      "feedback": "User's description of requested changes",
      "iteration": 1
    }
    ```
  - Launch `analyzer` agent (Opus) to revise the plan based on user feedback → Phase 3
  - Run Codex CLI to re-review the revised plan → Phase 2
  - Loop back to Phase 4 (User Review) so the user can verify the revised plan
  - Max 3 user-plan-review iterations, then escalate
- If **"Plan approved"** → continue to Phase 5
- If **"Cancel pipeline"** → stop

### Phase 5: Step-by-Step Implementation + Per-Step Review

After plan approval, read `.task/plan.json` to get `total_steps`. Update state with `current_step: 1` and `total_steps`.

**For each step N (1 to total_steps):**

1. Update state: `current_step: N`, `phase: "implementing_step_N"`
2. **5a: Implement Step N**
   - Launch `implementer` agent (model: opus) with `step_id: N`
   - Agent reads `.task/plan.json`, implements ONLY step N
   - Agent writes `.task/step-N-result.json`
3. **5b: Review Step N**
   - Run Codex CLI via Bash:
     ```
     node ${CLAUDE_PLUGIN_ROOT}/scripts/codex-review.js --type step-review --step-id N --project-dir ${PROJECT_DIR}
     ```
   - Codex reviews ONLY changes from step N, verifies step completeness
   - Codex writes `.task/step-N-review.json`
4. **Handle review result:**
   - If `status: "approved"` → proceed to step N+1
   - If `status: "needs_changes"` → re-launch implementer with `step_id: N` (reads `.task/step-N-review.json` for fixes), then re-review. Max 3 fix iterations per step.
   - If max iterations exhausted → escalate to user

After ALL steps complete, write `.task/impl-result.json` as a summary combining all `step-N-result.json` files:
```json
{
  "status": "complete",
  "has_ui_changes": true|false,
  "total_steps": 3,
  "steps_completed": [ /* merged from all step-N-result.json */ ],
  "files_changed": [ /* all files from all steps */ ]
}
```

### Phase 6: Final Code Review
- Run Codex CLI via Bash:
  ```
  node ${CLAUDE_PLUGIN_ROOT}/scripts/codex-review.js --type final-review --project-dir ${PROJECT_DIR}
  ```
- Codex reviews ALL changes across all steps, verifies overall completeness against the full plan
- Codex writes `.task/code-review.json`
- If `status: "needs_changes"` → launch implementer to fix (reads `.task/code-review.json`), then re-review (max 3 iterations)
- If `status: "approved"` → continue

### Phase 7: UI Verification (conditional)
- Only if `has_ui_changes: true` in impl-result
- Launch `ui-verifier` agent (model: opus)
- Agent uses Playwright MCP to navigate the app, take screenshots, verify visually
- Writes `.task/ui-review.json`
- If issues found → launch implementer to fix, then re-verify

### Completion
- Summarize all changes to the user
- Report final status

## Iteration Rules

- Max 3 plan review iterations before escalating to user
- Max 3 user plan review iterations before escalating to user
- Max 3 per-step code review iterations (per step) before escalating to user
- Max 3 final code review iterations before escalating to user
- Max 2 UI fix iterations before escalating to user
- Always show the user what failed and why

## Error Handling

- If any agent fails → report the error, ask user how to proceed
- If Codex is unavailable → skip Codex steps, warn user
- If Playwright is unavailable → skip UI verification, warn user

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

Phase values during step execution: `implementing_step_N`, `reviewing_step_N`, `final_review`.
