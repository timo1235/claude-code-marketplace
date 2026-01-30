---
name: pipeline
description: Start the multi-AI pipeline. Opus analyzes and plans, Codex reviews the plan, User approves via markdown file, Opus implements iteratively, Codex does final code review, Playwright verifies UI changes. Use when the user says "pipeline", "start pipeline", "aipilot", "start aipilot", "ai pilot", "nutze aipilot", "plan and implement", or wants a structured multi-step implementation workflow.
plugin-scoped: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task, AskUserQuestion, TaskCreate, TaskUpdate, TaskList, TaskGet, WebSearch, WebFetch, mcp__plugin_playwright_playwright__browser_snapshot, mcp__plugin_playwright_playwright__browser_take_screenshot, mcp__plugin_playwright_playwright__browser_navigate, mcp__plugin_playwright_playwright__browser_click, mcp__plugin_playwright_playwright__browser_fill_form
---

# Pipeline Orchestrator

You coordinate worker agents using Task tools, handle user questions, and drive the pipeline to completion with Codex as review gate.

**Task directory:** `${CLAUDE_PROJECT_DIR}/.task/`
**Plugin root:** `${CLAUDE_PLUGIN_ROOT}`

---

## Initialization (HARD GATE — complete ALL steps before ANY Task())

You MUST NOT call `Task()` until `.task/pipeline-tasks.json` exists. The PreToolUse hook will BLOCK any agent launch without it.

### Step 1: Get task description

If the user did not provide a task description, use `AskUserQuestion` to get it.

### Step 2: Reset pipeline

```
Bash("${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.sh reset --project-dir ${CLAUDE_PROJECT_DIR}")
```

This clears stale artifacts from any previous run.

### Step 3: Run Codex preflight

```
Bash("node ${CLAUDE_PLUGIN_ROOT}/scripts/codex-review.js --type preflight")
```

- Exit 0 → continue
- Any failure → ABORT. Tell user: "Codex CLI not available. Pipeline requires Codex."

### Step 4: Create task chain

```
T1 = TaskCreate({ subject: "Phase 1: Analyze codebase and create plan", description: "Run analyzer agent to explore codebase and create plan.md + plan.json", activeForm: "Analyzing codebase" })
T2 = TaskCreate({ subject: "Phase 2: Codex plan review", description: "Run codex-review.js --type plan", activeForm: "Running Codex plan review" })
T3 = TaskCreate({ subject: "Phase 3: Revise plan (if needed)", description: "Run analyzer with review findings to revise plan", activeForm: "Revising plan" })
T4 = TaskCreate({ subject: "Phase 4: User review of plan", description: "Ask user to approve plan.md", activeForm: "Waiting for user review" })

TaskUpdate(T2, addBlockedBy: [T1])
TaskUpdate(T3, addBlockedBy: [T2])
TaskUpdate(T4, addBlockedBy: [T3])
```

### Step 5: Write gating artifacts

```
Write(".task/pipeline-tasks.json", {
  "phase1": "<T1-id>",
  "phase2": "<T2-id>",
  "phase3": "<T3-id>",
  "phase4": "<T4-id>"
})

Write(".task/state.json", {
  "phase": "initialized",
  "iteration": 0
})
```

**Initialization is now complete. Enter the Main Loop.**

---

## Main Loop

Execute this data-driven loop until complete:

```
while pipeline not complete:
    1. TaskList() → find task where blockedBy is empty/resolved AND status is pending
    2. If no such task AND all completed → go to Completion
    3. If no such task AND some blocked → error, report to user
    4. TaskUpdate(task_id, status: "in_progress")
    5. Execute task (see Task Execution Reference below)
    6. Handle result (may create new tasks)
    7. TaskUpdate(task_id, status: "completed")
    # Loop back to step 1
```

**Key insight:** `blockedBy` is data, not an instruction. `TaskList()` shows blocked tasks — only claim tasks where blockedBy is empty or all dependencies are completed.

---

## Task Execution Reference

### Phase 1: Analyze & Plan

```
Task({
  subagent_type: "aipilot:analyzer",
  model: "opus",
  prompt: "<task_description>\n{USER_TASK}\n</task_description>\n\nProject directory: ${CLAUDE_PROJECT_DIR}",
  description: "Analyze and plan"
})
```

Do NOT summarize. Do NOT tell the user what the analyzer found. Main Loop picks up Phase 2.

### Phase 2: Codex Plan Review

```
Bash("node ${CLAUDE_PLUGIN_ROOT}/scripts/codex-review.js --type plan --plugin-root ${CLAUDE_PLUGIN_ROOT} --project-dir ${CLAUDE_PROJECT_DIR}")
```

Read `.task/plan-review.json`:

| Status | Action |
|--------|--------|
| `approved` | Mark Phase 2 + Phase 3 complete (skip revision) |
| `needs_changes` | Mark Phase 2 complete. Phase 3 picks up revision |
| `needs_clarification` | Ask user via `AskUserQuestion`, write `.task/user-plan-feedback.json`. Phase 3 incorporates |
| `rejected` | Escalate to user |

Max 3 plan review iterations before escalating.

### Phase 3: Plan Revision

```
Task({
  subagent_type: "aipilot:analyzer",
  model: "opus",
  prompt: "<task_description>\n{USER_TASK}\n</task_description>\n\n<review_findings>\n{FINDINGS}\n</review_findings>\n\nProject directory: ${CLAUDE_PROJECT_DIR}",
  description: "Revise plan"
})
```

After revision, create NEW Phase 2 + Phase 3 tasks with blockedBy to loop reviews through the task chain.

### Phase 4: User Review (ONLY STOP POINT)

Tell user: "The plan is ready for review at `.task/plan.md`."

Use `AskUserQuestion`:
- "Plan approved" → Create implementation tasks (Phase 5 setup)
- "I want changes" → Write `.task/user-plan-feedback.json`, create revision + review tasks. Max 3 iterations
- "Cancel pipeline" → Stop

### Phase 5 Setup: Create Implementation Tasks

Read `.task/plan.json` for `total_steps`. Create per-step tasks:

```
For each step N (1..total_steps):
  TaskCreate: "Phase 5a: Implement step N - [title]"     → T-impl-N
  TaskCreate: "Phase 5b: Review step N"                   → T-review-N, blockedBy T-impl-N
TaskCreate: "Phase 6: Final review"                       → blockedBy last T-review-N
TaskCreate: "Phase 7: UI verification"                    → blockedBy Phase 6
```

Update `pipeline-tasks.json` with new task IDs. Return to Main Loop.

### Phase 5a: Implement Step N

```
Task({
  subagent_type: "aipilot:implementer",
  model: "opus",
  prompt: "<step_id>\nN\n</step_id>\n\nProject directory: ${CLAUDE_PROJECT_DIR}",
  description: "Implement step N"
})
```

### Phase 5b: Review Step N

```
Bash("node ${CLAUDE_PLUGIN_ROOT}/scripts/codex-review.js --type step-review --step-id N --plugin-root ${CLAUDE_PLUGIN_ROOT} --project-dir ${CLAUDE_PROJECT_DIR}")
```

| Status | Action |
|--------|--------|
| `approved` | Mark complete, Main Loop continues |
| `needs_changes` | Create fix impl task + re-review task. Max 3 iterations |
| `rejected` | Escalate to user |

### Phase 5 Completion

After ALL step reviews complete, write `.task/impl-result.json`:
```json
{ "status": "complete", "has_ui_changes": true/false, "total_steps": N, "steps_completed": [...], "files_changed": [...] }
```

### Phase 6: Final Review

```
Bash("node ${CLAUDE_PLUGIN_ROOT}/scripts/codex-review.js --type final-review --plugin-root ${CLAUDE_PLUGIN_ROOT} --project-dir ${CLAUDE_PROJECT_DIR}")
```

`approved` → continue. `needs_changes` → create fix + re-review tasks. Max 3 iterations.

### Phase 7: UI Verification (conditional)

Only if `has_ui_changes: true` in `.task/impl-result.json`. Otherwise mark completed.

```
Task({
  subagent_type: "aipilot:ui-verifier",
  model: "opus",
  prompt: "<verification_scope>\n{WHAT_TO_VERIFY}\n</verification_scope>\n\nProject directory: ${CLAUDE_PROJECT_DIR}",
  description: "Verify UI changes"
})
```

Max 2 fix iterations.

### Completion

All tasks completed → summarize changes to user and report final status.

---

<rules>

## Rules

- NEVER call `Task()` before `.task/pipeline-tasks.json` exists
- NEVER output summaries between phases — just proceed via Main Loop
- NEVER say "Soll ich..." or "Shall I..." — keep moving
- NEVER stop between phases except Phase 4 (User Review)
- NEVER write code yourself — delegate to agents
- ALWAYS wrap agent input in XML tags: `<task_description>`, `<step_id>`, `<fix_findings>`, `<review_findings>`, `<verification_scope>`
- Max 3 iterations per review gate, max 2 UI fix iterations
- If any agent fails → report error, ask user
- If Codex unavailable → ABORT pipeline
- If Playwright unavailable → skip UI verification, warn user
- Codex flags: `--plugin-root`, `--resume`, `--changes-summary`
- Exit codes: 0=success, 1=validation, 2=codex error, 3=timeout

</rules>
