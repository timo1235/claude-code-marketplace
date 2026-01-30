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
Phase 1: Analyze & Plan       (Opus)      → .task/plan.md + .task/plan.json
Phase 2: Plan Review           (Codex)     → .task/plan-review.json
Phase 3: Plan Revision         (Opus)      → Updated .task/plan.md (if needed)
Phase 4: User Review           (Manual)    → User reviews/edits plan, loops through 2-3-4
Phase 5: Implementation        (Opus)      → Code changes, iterative
Phase 6: Code Review           (Codex)     → .task/code-review.json
Phase 7: UI Verification       (Opus)      → .task/ui-review.json (if UI changes)
```

## Your Role

You are the orchestrator. You do NOT do the work yourself. You:
1. Create the task chain with proper `blockedBy` dependencies
2. Launch specialized agents via the `Task` tool
3. Read agent outputs and decide next steps
4. Handle iteration loops (review → fix → re-review)
5. Communicate progress to the user

## Startup Sequence

When the user invokes this skill:

1. **Ask for the task description** if not already provided
2. **Initialize the pipeline:**
   - Copy `.task.template/state.json` to project `.task/state.json` (create `.task/` if needed)
   - Create the task chain (see below)
3. **Run Phase 1** immediately

## Task Chain Creation

Create these tasks with `TaskCreate` and proper `blockedBy`:

```
T1: "Analyze codebase and create implementation plan"     blockedBy: []
T2: "Review plan with Codex"                               blockedBy: [T1]
T3: "Revise plan based on review"                          blockedBy: [T2]
T4: "User review of plan"                                  blockedBy: [T3]
T5: "Implement plan"                                       blockedBy: [T4]
T6: "Code review with Codex"                               blockedBy: [T5]
T7: "UI verification with Playwright"                      blockedBy: [T6]
```

Store task IDs in `.task/pipeline-tasks.json`.

## Phase Execution

### Phase 1: Analyze & Plan
- Launch `analyzer` agent (model: opus) with the user's task description
- Agent reads codebase, creates `.task/plan.md` and `.task/plan.json`
- Mark T1 complete when done

### Phase 2: Plan Review
- Launch `plan-reviewer` agent (model: codex via script)
- Agent reads `.task/plan.md` and `.task/plan.json`, writes `.task/plan-review.json`
- If `status: "needs_changes"` → proceed to Phase 3
- If `status: "approved"` → skip Phase 3, go to Phase 4

### Phase 3: Plan Revision
- Launch `analyzer` agent again with review findings
- Agent updates `.task/plan.md` and `.task/plan.json`
- Loop back to Phase 2 (max 3 iterations, then escalate to user)

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
  - Launch `plan-reviewer` agent (Codex) to re-review the revised plan → Phase 2
  - Loop back to Phase 4 (User Review) so the user can verify the revised plan
  - Max 3 user-plan-review iterations, then escalate
- If **"Plan approved"** → continue to Phase 5
- If **"Cancel pipeline"** → stop

### Phase 5: Implementation
- Launch `implementer` agent (model: opus)
- Agent reads `.task/plan.json`, implements step by step
- Agent creates subtasks for each plan step
- Agent writes `.task/impl-result.json` when done
- Check `has_ui_changes` in result to decide Phase 7

### Phase 6: Code Review
- Launch `code-reviewer` agent (model: codex via script)
- Agent reviews all changed files, writes `.task/code-review.json`
- If `status: "needs_changes"` → launch implementer to fix, then re-review (max 3 iterations)
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
- Max 3 code review iterations before escalating to user
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
  "phase": "implementing",
  "plan_approved": true,
  "implementation_complete": false,
  "code_review_passed": false,
  "ui_review_passed": false,
  "has_ui_changes": false,
  "iteration": 0
}
```
