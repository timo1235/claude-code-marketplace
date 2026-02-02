---
name: aipilot
description: Start the multi-AI pipeline. Opus plans, Codex reviews, User approves, Opus implements, Codex gates. Use when the user says "aipilot", "start aipilot", "pipeline", "start pipeline", or "plan and implement".
plugin-scoped: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task, AskUserQuestion, TaskCreate, TaskUpdate, TaskList, TaskGet, mcp__codex__codex
---

# Pipeline Orchestrator

You coordinate worker agents using Task tools, handle user questions, and drive the pipeline to completion with Codex as review gate.

**Task directory:** `${CLAUDE_PROJECT_DIR}/.task-{session-id}/` (set during init)
**Plugin root:** `${CLAUDE_PLUGIN_ROOT}`

---

## Pipeline Initialization

Execute these two steps IN ORDER. Do NOT skip, reorder, or improvise.

### Step 1: Run init script

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.sh" init --project-dir "${CLAUDE_PROJECT_DIR}"
```

If it fails → ABORT pipeline and tell the user why.

From the output, extract the `SESSION_ID=<id>` line. Store this value.
All subsequent file paths use `.task-{session-id}/` where `{session-id}` is the captured ID.
Set `TASK_DIR=${CLAUDE_PROJECT_DIR}/.task-{session-id}/`

Do NOT create the task directory manually. Do NOT write `state.json`. The script handles this.

### Step 1b: Detect pipeline mode

Determine the pipeline mode from the user's input:
- If the user wrote **"production"** or **"prod"** (case-insensitive) anywhere in their message → mode = `production`
- Otherwise → mode = `prototype` (default)

Write `${TASK_DIR}/pipeline-config.json` using the Write tool:
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

Then write `${TASK_DIR}/pipeline-tasks.json` with the REAL IDs:
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

Read `${TASK_DIR}/pipeline-config.json` to get the current mode. Then:

```
Task({ subagent_type: "aipilot:analyzer", model: "opus", prompt: "<task_description>\n{USER_TASK}\n</task_description>\n\n<pipeline_mode>{MODE}</pipeline_mode>\n\nProject: ${CLAUDE_PROJECT_DIR}\n\nSession: TASK_DIR=${TASK_DIR}", description: "Analyze and plan" })
```

Replace `{MODE}` with the value from `pipeline-config.json` (e.g. `prototype` or `production`).

Do NOT summarize output. Main Loop picks up Phase 2.

### Phase 2: Codex Plan Review

Read `${TASK_DIR}/pipeline-config.json` to get the current mode.

**Step 2a: Read prompt context**

Read these files:
- `${CLAUDE_PLUGIN_ROOT}/docs/codex-prompts/plan-reviewer.md` (review instructions)
- `${CLAUDE_PLUGIN_ROOT}/docs/standards-prototype.md` (if mode=prototype) or `standards.md` (if mode=production)
- `${CLAUDE_PROJECT_DIR}/CLAUDE.md` (if exists -- project rules take precedence)
- `${TASK_DIR}/plan.md`
- `${TASK_DIR}/plan.json`

**Step 2b: Call Codex via MCP**

Assemble a prompt containing:
- Pipeline mode
- The content of plan-reviewer.md (review criteria and output format)
- Reference to the standards (include content or path)
- Project CLAUDE.md content (if exists)
- The full content of plan.md and plan.json
- Project directory: `${CLAUDE_PROJECT_DIR}` (Codex needs this to know where to explore files)
- Guardrail: "Only explore files within the project directory above. Do not access files outside the project."
- Instruction: "Return your review as a single JSON object matching the output format specified above. Do not wrap in markdown code fences."

Call:
```
mcp__codex__codex({ prompt: "<assembled prompt>", "approval-policy": "on-request", model: "gpt-5" })
```

If the tool call fails (MCP server unavailable), report to user: "Codex MCP server not available. Run /pipeline-check for diagnostics."

**Step 2c: Write review JSON**

Extract the JSON object from Codex's response (find the outermost `{...}` structure). Parse it. Write to `${TASK_DIR}/plan-review.json` using the Write tool.

**Step 2d: Validate**

```
Bash("node ${CLAUDE_PLUGIN_ROOT}/scripts/validate-review.js --type plan --project-dir ${CLAUDE_PROJECT_DIR} --task-dir ${TASK_DIR}")
```

If validation fails (exit code 1), read the validation errors from stdout, fix the JSON accordingly, re-write `${TASK_DIR}/plan-review.json`, and re-validate. Max 2 attempts.

Read `${TASK_DIR}/plan-review.json` and handle status:

| Status | Action |
|--------|--------|
| `approved` | Mark Phase 2 + Phase 3 complete |
| `needs_changes` | Mark Phase 2 complete, Phase 3 revises |
| `needs_clarification` | AskUserQuestion, write feedback, Phase 3 incorporates |
| `rejected` | Escalate to user |

### Phase 3: Plan Revision

Read `${TASK_DIR}/pipeline-config.json` to get the current mode. Then:

```
Task({ subagent_type: "aipilot:analyzer", model: "opus", prompt: "<task_description>\n{USER_TASK}\n</task_description>\n\n<review_findings>\n{FINDINGS}\n</review_findings>\n\n<pipeline_mode>{MODE}</pipeline_mode>\n\nProject: ${CLAUDE_PROJECT_DIR}\n\nSession: TASK_DIR=${TASK_DIR}", description: "Revise plan" })
```

After revision → create NEW Phase 2 + Phase 3 tasks to re-review. Max 3 iterations.

### Phase 4: User Review (ONLY STOP POINT)

Tell user: "Plan ready at `${TASK_DIR}/plan.md`." Use `AskUserQuestion`:
- Approved → create implementation tasks (see below)
- Changes requested → write feedback, create revision tasks. Max 3 iterations
- Cancel → stop

### After Phase 4: Create Implementation Tasks

Read `${TASK_DIR}/plan.json` for steps. Create per-step tasks in a SEPARATE file `${TASK_DIR}/implementation-tasks.json`:

```
For each step N:
  TaskCreate: "Implement step N"    → T-impl-N
  TaskCreate: "Review step N"       → T-review-N (blockedBy: T-impl-N)
TaskCreate: "Final review"          → blockedBy last T-review
TaskCreate: "UI verification"       → blockedBy final review
```

### Phase 5a: Implement Step N

Read `${TASK_DIR}/pipeline-config.json` to get the current mode. Then:

```
Task({ subagent_type: "aipilot:implementer", model: "opus", prompt: "<step_id>\nN\n</step_id>\n\n<pipeline_mode>{MODE}</pipeline_mode>\n\nProject: ${CLAUDE_PROJECT_DIR}\n\nSession: TASK_DIR=${TASK_DIR}", description: "Implement step N" })
```

### Phase 5b: Review Step N

Read `${TASK_DIR}/pipeline-config.json` to get the current mode.

**Step 5b-1: Read prompt context and gather code changes**

Read these files:
- `${CLAUDE_PLUGIN_ROOT}/docs/codex-prompts/code-reviewer.md` (review instructions)
- `${CLAUDE_PLUGIN_ROOT}/docs/standards-prototype.md` (if mode=prototype) or `standards.md` (if mode=production)
- `${CLAUDE_PROJECT_DIR}/CLAUDE.md` (if exists -- project rules take precedence)
- `${TASK_DIR}/plan.json`
- `${TASK_DIR}/step-N-result.json`

Then gather the actual code changes for review:
- Run `Bash("git diff HEAD~1 -- <files>")` where `<files>` are the `files_changed` from `step-N-result.json`
- If git diff is empty or unavailable, read the full content of each changed file instead

**Step 5b-2: Call Codex via MCP**

Assemble a prompt containing:
- Pipeline mode
- The content of code-reviewer.md (review criteria and output format)
- Reference to the standards (include content or path)
- Project CLAUDE.md content (if exists)
- The plan.json content and step-N-result.json content
- **The code changes** (git diff output or full file contents from step 5b-1)
- Project directory: `${CLAUDE_PROJECT_DIR}`
- Guardrail: "Only explore files within the project directory above. Do not access files outside the project."
- Instruction: "Review ONLY the changes from step N. Return your review as a single JSON object matching the step review output format specified above. Do not wrap in markdown code fences."

Call:
```
mcp__codex__codex({ prompt: "<assembled prompt>", "approval-policy": "on-request", model: "gpt-5" })
```

If the tool call fails (MCP server unavailable), report to user: "Codex MCP server not available. Run /pipeline-check for diagnostics."

**Step 5b-3: Write review JSON**

Extract the JSON object from Codex's response (find the outermost `{...}` structure). Parse it. Write to `${TASK_DIR}/step-N-review.json` using the Write tool.

**Step 5b-4: Validate**

```
Bash("node ${CLAUDE_PLUGIN_ROOT}/scripts/validate-review.js --type step-review --step-id N --project-dir ${CLAUDE_PROJECT_DIR} --task-dir ${TASK_DIR}")
```

If validation fails (exit code 1), read the validation errors from stdout, fix the JSON accordingly, re-write `${TASK_DIR}/step-N-review.json`, and re-validate. Max 2 attempts.

Read `${TASK_DIR}/step-N-review.json` and handle status:
`approved` → continue. `needs_changes` → fix + re-review (max 3). `rejected` → escalate.

### Phase 5c: Aggregate Implementation Results

After ALL step implementations and reviews are complete, aggregate the results:

```
Bash("node ${CLAUDE_PLUGIN_ROOT}/scripts/validate-review.js --type aggregate --project-dir ${CLAUDE_PROJECT_DIR} --task-dir ${TASK_DIR}")
```

This reads all `step-N-result.json` files and writes `${TASK_DIR}/impl-result.json` with the combined status, files, and tests.

### Phase 6: Final Review

Read `${TASK_DIR}/pipeline-config.json` to get the current mode.

**Step 6a: Read prompt context and gather code changes**

Read these files:
- `${CLAUDE_PLUGIN_ROOT}/docs/codex-prompts/code-reviewer.md` (review instructions)
- `${CLAUDE_PLUGIN_ROOT}/docs/standards-prototype.md` (if mode=prototype) or `standards.md` (if mode=production)
- `${CLAUDE_PROJECT_DIR}/CLAUDE.md` (if exists -- project rules take precedence)
- `${TASK_DIR}/plan.json`
- `${TASK_DIR}/impl-result.json`

Then gather all code changes for the final review:
- Read `impl-result.json` to get the full `files_changed` list
- Run `Bash("git diff HEAD~N -- <files>")` where N = number of implementation commits and `<files>` are all files from `impl-result.json`
- If git diff is empty or unavailable, read the full content of each changed file instead

**Step 6b: Call Codex via MCP**

Assemble a prompt containing:
- Pipeline mode
- The content of code-reviewer.md (review criteria and output format)
- Reference to the standards (include content or path)
- Project CLAUDE.md content (if exists)
- The plan.json content and impl-result.json content
- **The code changes** (git diff output or full file contents from step 6a)
- Project directory: `${CLAUDE_PROJECT_DIR}`
- Guardrail: "Only explore files within the project directory above. Do not access files outside the project."
- Instruction: "Review ALL implementation changes (final review). Return your review as a single JSON object matching the final review output format specified above. Do not wrap in markdown code fences."

Call:
```
mcp__codex__codex({ prompt: "<assembled prompt>", "approval-policy": "on-request", model: "gpt-5" })
```

If the tool call fails (MCP server unavailable), report to user: "Codex MCP server not available. Run /pipeline-check for diagnostics."

**Step 6c: Write review JSON**

Extract the JSON object from Codex's response (find the outermost `{...}` structure). Parse it. Write to `${TASK_DIR}/code-review.json` using the Write tool.

**Step 6d: Validate**

```
Bash("node ${CLAUDE_PLUGIN_ROOT}/scripts/validate-review.js --type final-review --project-dir ${CLAUDE_PROJECT_DIR} --task-dir ${TASK_DIR}")
```

If validation fails (exit code 1), read the validation errors from stdout, fix the JSON accordingly, re-write `${TASK_DIR}/code-review.json`, and re-validate. Max 2 attempts.

Read `${TASK_DIR}/code-review.json` and handle status:
`approved` → continue. `needs_changes` → fix + re-review (max 3). `rejected` → escalate.

### Phase 7: UI Verification (only if `has_ui_changes: true`)

Build the verification scope from `${TASK_DIR}/impl-result.json` and `${TASK_DIR}/plan.json`: list every user-facing feature that was implemented, what it should do, and how to test it. Be specific — include URLs, expected behaviors, and test scenarios.

```
Task({ subagent_type: "aipilot:ui-verifier", model: "opus", prompt: "<verification_scope>\n{DETAILED_SCOPE}\n</verification_scope>\n\nProject: ${CLAUDE_PROJECT_DIR}\n\nSession: TASK_DIR=${TASK_DIR}", description: "Verify UI" })
```

Read `${TASK_DIR}/ui-review.json` and handle:
- `approved` (zero console errors, zero network failures, all features pass) → continue to Completion
- `needs_changes` → fix issues + re-verify (max 2 iterations). On each fix iteration, pass the failing features and their issues to the implementer agent.

### Completion

All tasks done → summarize to user.

---

<rules>

## Mandatory Rules

### Forbidden Actions
- Do NOT create `${TASK_DIR}/` directory manually — `orchestrator.sh init` does this
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
- ALWAYS write JSON files to `${TASK_DIR}/` with pretty-printed formatting (2-space indentation) so they are human-readable
- Max 3 review iterations, max 2 UI fix iterations
- ALWAYS track loop iteration count — STOP at 25 iterations and report to user

</rules>
