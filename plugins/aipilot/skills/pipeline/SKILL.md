---
name: pipeline
description: Start the multi-AI pipeline. Opus analyzes and plans, Codex reviews the plan, User approves via markdown file, Opus implements iteratively, Codex does final code review, Playwright verifies UI changes. Use when the user says "pipeline", "start pipeline", "plan and implement", or wants a structured multi-step implementation workflow.
plugin-scoped: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task, AskUserQuestion, TaskCreate, TaskUpdate, TaskList, TaskGet, WebSearch, WebFetch, mcp__plugin_playwright_playwright__browser_snapshot, mcp__plugin_playwright_playwright__browser_take_screenshot, mcp__plugin_playwright_playwright__browser_navigate, mcp__plugin_playwright_playwright__browser_click, mcp__plugin_playwright_playwright__browser_fill_form
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

You are the orchestrator. You coordinate the pipeline by:
1. Creating the task chain with `TaskCreate` and `blockedBy` dependencies
2. Launching Opus agents via the `Task` tool (analyzer, implementer, ui-verifier)
3. Running Codex reviews via `Bash` tool (plan review, step review, final review)
4. Reading agent/review outputs and deciding next steps
5. Handling iteration loops (review → fix → re-review)
6. Communicating progress to the user

You do NOT write code or analyze the codebase yourself — you delegate to specialized agents and Codex CLI.

## How to Launch Agents and Reviews

### Launching an Opus Agent (Task tool)

Use the `Task` tool with `subagent_type` matching the agent name and `model: "opus"`:

```
Task({
  subagent_type: "opus-pipeline:implementer",
  model: "opus",
  prompt: "Implement step 1 of the plan. step_id: 1\n\nProject directory: /path/to/project",
  description: "Implement step 1"
})
```

Available agent types: `opus-pipeline:analyzer`, `opus-pipeline:implementer`, `opus-pipeline:ui-verifier`

### Running a Codex Review (Bash tool)

Use the `Bash` tool to run the codex-review.js script. Resolve paths as follows:
- **Plugin root**: Use the directory where this skill file lives, two levels up (the plugin root containing `scripts/`)
- **Project directory**: Use the current working directory or `process.env.CLAUDE_PROJECT_DIR`

```
Bash("node /path/to/plugin/scripts/codex-review.js --type plan --project-dir /path/to/project")
```

To find the plugin scripts directory, first run:
```
Bash("find / -path '*/aipilot/scripts/codex-review.js' -type f 2>/dev/null | head -1")
```
Cache this path for all subsequent Codex calls in the session.

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

Create these initial tasks using `TaskCreate`. Use `TaskUpdate` with `addBlockedBy` to set dependencies after creation (you need the task IDs first):

1. `TaskCreate({ subject: "Phase 1: Analyze codebase and create plan", ... })` → save ID as T1
2. `TaskCreate({ subject: "Phase 2: Codex plan review", ... })` → save ID as T2, then `TaskUpdate({ taskId: T2, addBlockedBy: [T1] })`
3. `TaskCreate({ subject: "Phase 3: Revise plan (if needed)", ... })` → save ID as T3, then `TaskUpdate({ taskId: T3, addBlockedBy: [T2] })`
4. `TaskCreate({ subject: "Phase 4: User review of plan", ... })` → save ID as T4, then `TaskUpdate({ taskId: T4, addBlockedBy: [T3] })`

After Phase 4 (plan approved), create per-step tasks dynamically. Read `plan.json`, count the `steps` array, then for each step N:

5. `TaskCreate({ subject: "Phase 5a: Implement step N - [title]", ... })` → T-impl-N
6. `TaskCreate({ subject: "Phase 5b: Codex review step N", ... })` → T-review-N, blockedBy T-impl-N

Chain: T-impl-1 → T-review-1 → T-impl-2 → T-review-2 → ... → T-final-review → T-ui

7. `TaskCreate({ subject: "Phase 6: Final code review", ... })` → blockedBy last T-review-N
8. `TaskCreate({ subject: "Phase 7: UI verification", ... })` → blockedBy T-final-review

Store all task IDs in `.task/pipeline-tasks.json` for reference.

## Phase Execution

### Phase 1: Analyze & Plan
- Launch `analyzer` agent (model: opus) with the user's task description
- Agent reads codebase, creates `.task/plan.md` and `.task/plan.json`
- Mark T1 complete when done
- **→ IMMEDIATELY proceed to Phase 2. Do NOT stop here.**

### Phase 2: Plan Review
- Run Codex CLI via `Bash` tool (use the cached script path from startup):
  ```
  node <SCRIPT_PATH>/codex-review.js --type plan --project-dir <PROJECT_DIR>
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
- If **"Plan approved"** → continue to Phase 5
- If **"Cancel pipeline"** → stop
- If **"I want changes"**:
  1. Ask the user to describe what should change (use `AskUserQuestion` with free text)
  2. Write the user's feedback to `.task/user-plan-feedback.json`:
     ```json
     {
       "status": "needs_changes",
       "feedback": "User's description of requested changes",
       "iteration": 1
     }
     ```
  3. Launch `analyzer` agent (Opus) to revise the plan based on user feedback
  4. Run Codex CLI plan review on the revised plan
  5. Return to Phase 4 — present the revised plan to the user again
  6. Max 3 user-revision iterations, then escalate

### Phase 5: Step-by-Step Implementation + Per-Step Review

After plan approval, read `.task/plan.json` to get `total_steps`. Update state with `current_step: 1` and `total_steps`.

**For each step N (1 to total_steps):**

1. Update state: `current_step: N`, `phase: "implementing_step_N"`
2. **5a: Implement Step N**
   - Launch `implementer` agent (model: opus) with `step_id: N`
   - Agent reads `.task/plan.json`, implements ONLY step N
   - Agent writes `.task/step-N-result.json`
3. **5b: Review Step N**
   - Run Codex CLI via `Bash` tool:
     ```
     node <SCRIPT_PATH>/codex-review.js --type step-review --step-id N --project-dir <PROJECT_DIR>
     ```
   - Codex reviews ONLY changes from step N, verifies step completeness
   - Codex writes `.task/step-N-review.json`
4. **Handle review result:**
   - If `status: "approved"` → proceed to step N+1
   - If `status: "needs_changes"` → re-launch implementer with `step_id: N` (reads `.task/step-N-review.json` for fixes), then re-review. Max 3 fix iterations per step.
   - If `status: "rejected"` → escalate to user immediately (fundamental problem with this step)
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
- Run Codex CLI via `Bash` tool:
  ```
  node <SCRIPT_PATH>/codex-review.js --type final-review --project-dir <PROJECT_DIR>
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
