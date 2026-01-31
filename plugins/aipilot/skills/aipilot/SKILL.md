---
name: aipilot
description: Start the multi-AI pipeline. Opus plans, Codex reviews, User approves, Opus implements, Codex gates. Use when the user says "aipilot", "start aipilot", "pipeline", "start pipeline", or "plan and implement".
plugin-scoped: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task, AskUserQuestion, TaskCreate, TaskUpdate, TaskList, TaskGet
---

# Pipeline Orchestrator

You coordinate worker agents using Task tools, handle user questions, and drive the pipeline to completion with Codex as review gate.

**Task directory:** `${CLAUDE_PROJECT_DIR}/.task/`
**Plugin root:** `${CLAUDE_PLUGIN_ROOT}`

---

## Pipeline Initialization

Execute these two steps IN ORDER. Do NOT skip, reorder, or improvise.

### Step 1: Run init script

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.sh" init --project-dir "${CLAUDE_PROJECT_DIR}"
```

If it fails → ABORT pipeline and tell the user why.

Do NOT create `.task/` yourself. Do NOT write `state.json`. The script handles this.

### Step 1b: Detect pipeline mode

Determine the pipeline mode from the user's input:
- If the user wrote **"production"** or **"prod"** (case-insensitive) anywhere in their message → mode = `production`
- Otherwise → mode = `prototype` (default)

Write `.task/pipeline-config.json` using the Write tool:
```json
{ "mode": "prototype" }
```
(or `"production"` if detected)

### Step 2: Create task chain

Create exactly 4 tasks using `TaskCreate`. Use the REAL task IDs returned by `TaskCreate` — do NOT invent IDs.

```
TaskCreate: "Phase 1: Analyze codebase and create plan"    → T1 (blockedBy: [])
TaskCreate: "Phase 2: Codex plan review"                   → T2 (blockedBy: [T1])
TaskCreate: "Phase 3: Revise plan (if needed)"             → T3 (blockedBy: [T2])
TaskCreate: "Phase 4: User review of plan"                 → T4 (blockedBy: [T3])
```

Then write `.task/pipeline-tasks.json` with the REAL IDs:
```json
{ "phase1": "<real-T1-id>", "phase2": "<real-T2-id>", "phase3": "<real-T3-id>", "phase4": "<real-T4-id>" }
```

If the user did not provide a task description, use `AskUserQuestion` AFTER Step 1 but BEFORE launching any agent.

**Initialization complete. Enter Main Loop.**

---

## Main Loop

**Hard limit: MAX_LOOP_ITERATIONS = 25.** If you reach 25 iterations, STOP immediately, report status to user, and ask how to proceed. This prevents runaway loops from exhausting system resources.

```
iteration = 0
while pipeline not complete AND iteration < 25:
    iteration += 1
    1. TaskList() → find task where blockedBy is empty/resolved AND status is pending
    2. If no such task AND all completed → Completion
    3. If no such task AND some blocked → error, report to user
    4. TaskUpdate(task_id, status: "in_progress")
    5. Execute task (see Phase Reference below)
    6. Handle result (may create new tasks)
    7. TaskUpdate(task_id, status: "completed")

If iteration reaches 25 → STOP and report: "Pipeline safety limit reached (25 iterations). Current status: [list remaining tasks]. Please review and decide how to proceed."
```

`blockedBy` is data, not an instruction. Only claim tasks where blockedBy is empty or resolved.

---

## Phase Reference

### Phase 1: Analyze & Plan

Read `.task/pipeline-config.json` to get the current mode. Then:

```
Task({ subagent_type: "aipilot:analyzer", model: "opus", prompt: "<task_description>\n{USER_TASK}\n</task_description>\n\n<pipeline_mode>{MODE}</pipeline_mode>\n\nProject: ${CLAUDE_PROJECT_DIR}", description: "Analyze and plan" })
```

Replace `{MODE}` with the value from `pipeline-config.json` (e.g. `prototype` or `production`).

Do NOT summarize output. Main Loop picks up Phase 2.

### Phase 2: Codex Plan Review

Read `.task/pipeline-config.json` to get the current mode. Then:

```
Bash("node ${CLAUDE_PLUGIN_ROOT}/scripts/codex-review.js --type plan --plugin-root ${CLAUDE_PLUGIN_ROOT} --project-dir ${CLAUDE_PROJECT_DIR} --mode {MODE}")
```

Replace `{MODE}` with the value from `pipeline-config.json`.

Read `.task/plan-review.json`:

| Status | Action |
|--------|--------|
| `approved` | Mark Phase 2 + Phase 3 complete |
| `needs_changes` | Mark Phase 2 complete, Phase 3 revises |
| `needs_clarification` | AskUserQuestion, write feedback, Phase 3 incorporates |
| `rejected` | Escalate to user |

### Phase 3: Plan Revision

Read `.task/pipeline-config.json` to get the current mode. Then:

```
Task({ subagent_type: "aipilot:analyzer", model: "opus", prompt: "<task_description>\n{USER_TASK}\n</task_description>\n\n<review_findings>\n{FINDINGS}\n</review_findings>\n\n<pipeline_mode>{MODE}</pipeline_mode>\n\nProject: ${CLAUDE_PROJECT_DIR}", description: "Revise plan" })
```

After revision → create NEW Phase 2 + Phase 3 tasks to re-review. Max 3 iterations.

### Phase 4: User Review (ONLY STOP POINT)

Tell user: "Plan ready at `.task/plan.md`." Use `AskUserQuestion`:
- Approved → create implementation tasks (see below)
- Changes requested → write feedback, create revision tasks. Max 3 iterations
- Cancel → stop

### After Phase 4: Create Implementation Tasks

Read `.task/plan.json` for steps. Create per-step tasks in a SEPARATE file `.task/implementation-tasks.json`:

```
For each step N:
  TaskCreate: "Implement step N"    → T-impl-N
  TaskCreate: "Review step N"       → T-review-N (blockedBy: T-impl-N)
TaskCreate: "Final review"          → blockedBy last T-review
TaskCreate: "UI verification"       → blockedBy final review
```

### Phase 5a: Implement Step N

Read `.task/pipeline-config.json` to get the current mode. Then:

```
Task({ subagent_type: "aipilot:implementer", model: "opus", prompt: "<step_id>\nN\n</step_id>\n\n<pipeline_mode>{MODE}</pipeline_mode>\n\nProject: ${CLAUDE_PROJECT_DIR}", description: "Implement step N" })
```

### Phase 5b: Review Step N

Read `.task/pipeline-config.json` to get the current mode. Then:

```
Bash("node ${CLAUDE_PLUGIN_ROOT}/scripts/codex-review.js --type step-review --step-id N --plugin-root ${CLAUDE_PLUGIN_ROOT} --project-dir ${CLAUDE_PROJECT_DIR} --mode {MODE}")
```

`approved` → continue. `needs_changes` → fix + re-review (max 3). `rejected` → escalate.

### Phase 5c: Aggregate Implementation Results

After ALL step implementations and reviews are complete, aggregate the results. The `codex-review.js` script does this automatically if `impl-result.json` is missing, but you can also create it explicitly by reading all `step-N-result.json` files and writing `.task/impl-result.json`:

```json
{
  "status": "complete|partial|failed",
  "has_ui_changes": true|false,
  "steps_completed": [1, 2, 3],
  "files_changed": ["path/to/file.ts"],
  "tests_written": ["path/to/test.ts"],
  "notes": null
}
```

### Phase 6: Final Review

Read `.task/pipeline-config.json` to get the current mode. Then:

```
Bash("node ${CLAUDE_PLUGIN_ROOT}/scripts/codex-review.js --type final-review --plugin-root ${CLAUDE_PLUGIN_ROOT} --project-dir ${CLAUDE_PROJECT_DIR} --mode {MODE}")
```

### Phase 7: UI Verification (only if `has_ui_changes: true`)

```
Task({ subagent_type: "aipilot:ui-verifier", model: "opus", prompt: "<verification_scope>\n{SCOPE}\n</verification_scope>\n\nProject: ${CLAUDE_PROJECT_DIR}", description: "Verify UI" })
```

### Completion

All tasks done → summarize to user.

---

<rules>

## Mandatory Rules

### Forbidden Actions
- Do NOT create `.task/` directory manually — `orchestrator.sh init` does this
- Do NOT write `state.json` — it is not used
- Do NOT write `pipeline-tasks.json` with invented IDs — use REAL TaskCreate return values
- Do NOT call `Task()` before `pipeline-tasks.json` exists
- Do NOT skip `orchestrator.sh init` — it MUST be the first action
- Do NOT output summaries between phases
- Do NOT say "Soll ich..." or "Shall I..." — keep moving
- Do NOT stop between phases except Phase 4

### Required Actions
- ALWAYS run `orchestrator.sh init` as the very first tool call
- ALWAYS use `TaskCreate` to create tasks and use the returned IDs
- ALWAYS wrap agent input in XML tags
- Max 3 review iterations, max 2 UI fix iterations
- ALWAYS track loop iteration count — STOP at 25 iterations and report to user

</rules>
