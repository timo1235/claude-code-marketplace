---
name: pipeline
description: Start the multi-AI pipeline. Opus analyzes and plans, Codex reviews the plan, User approves via markdown file, Opus implements iteratively, Codex does final code review, Playwright verifies UI changes. Use when the user says "pipeline", "start pipeline", "aipilot", "start aipilot", "ai pilot", "nutze aipilot", "plan and implement", or wants a structured multi-step implementation workflow.
plugin-scoped: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task, AskUserQuestion, TaskCreate, TaskUpdate, TaskList, TaskGet, WebSearch, WebFetch, mcp__plugin_playwright_playwright__browser_snapshot, mcp__plugin_playwright_playwright__browser_take_screenshot, mcp__plugin_playwright_playwright__browser_navigate, mcp__plugin_playwright_playwright__browser_click, mcp__plugin_playwright_playwright__browser_fill_form
---

# Pipeline Orchestrator

**CRITICAL RULE — READ THIS FIRST:**
You MUST execute the entire pipeline as one continuous sequence. After EVERY phase, you IMMEDIATELY call the next tool — no summarizing, no asking the user, no pausing. The ONLY exception is Phase 4 (User Review). If you catch yourself about to write a summary and wait, STOP and call the next tool instead.

**FORBIDDEN behaviors (violating these breaks the pipeline):**
- NEVER output a summary after Phase 1 and ask the user what to do
- NEVER say "Soll ich..." or "Shall I..." or "Die Analyse ist abgeschlossen" and wait
- NEVER skip creating the task chain at startup
- NEVER stop between phases except Phase 4

## Execution Algorithm

Follow these steps EXACTLY in order. Each step tells you the NEXT ACTION to take.

### STEP 0: Initialize

Do ALL of the following before anything else:

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

**0d.** Create `.task/` directory and initialize state:
```
Bash("mkdir -p <PROJECT_DIR>/.task")
```

**0e.** Create the task chain — you MUST do this NOW, before Phase 1:
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

**→ YOUR NEXT ACTION: Start Phase 1.**

### STEP 1: Phase 1 — Analyze & Plan

Mark T1 as `in_progress`. Launch the analyzer:
```
Task({
  subagent_type: "aipilot:analyzer",
  model: "opus",
  prompt: "<task_description>\n{USER_TASK}\n</task_description>\n\nProject directory: <PROJECT_DIR>",
  description: "Analyze and plan"
})
```

When the agent returns, mark T1 as `completed`.

**→ YOUR NEXT ACTION: Do NOT summarize. Do NOT tell the user what the analyzer found. IMMEDIATELY start Phase 2. Your next tool call MUST be `Bash` to run Codex.**

### STEP 2: Phase 2 — Plan Review

Mark T2 as `in_progress`. Run Codex:
```
Bash("node <PLUGIN_ROOT>/scripts/codex-review.js --type plan --plugin-root <PLUGIN_ROOT> --project-dir <PROJECT_DIR>")
```

Read `.task/plan-review.json`. Mark T2 as `completed`.

- `status: "approved"` → Mark T3 as `completed` (skipped). Go to **STEP 4**.
- `status: "needs_changes"` → Go to **STEP 3**.
- `status: "needs_clarification"` → Read `clarification_questions`, ask user with `AskUserQuestion`, write answers to `.task/user-plan-feedback.json`, then go to **STEP 3**.
- `status: "rejected"` → Escalate to user.

**→ YOUR NEXT ACTION: Follow the branch above. No summarizing.**

### STEP 3: Phase 3 — Plan Revision

Mark T3 as `in_progress`. Launch analyzer with review findings:
```
Task({
  subagent_type: "aipilot:analyzer",
  model: "opus",
  prompt: "<task_description>\n{USER_TASK}\n</task_description>\n\n<review_findings>\n{FINDINGS_FROM_PLAN_REVIEW}\n</review_findings>\n\nProject directory: <PROJECT_DIR>",
  description: "Revise plan"
})
```

Mark T3 as `completed`.

**→ YOUR NEXT ACTION: Loop back to STEP 2 (max 3 iterations, then escalate to user).**

### STEP 4: Phase 4 — User Review (ONLY STOP POINT)

Mark T4 as `in_progress`. This is the ONE place you stop and ask the user.

Tell the user: "The plan is ready for review at `.task/plan.md`."

Use `AskUserQuestion`:
- "Plan approved" → Mark T4 as `completed`. Go to **STEP 5**.
- "I want changes" → Ask what should change, write to `.task/user-plan-feedback.json`, launch analyzer revision, re-run plan review, return here. Max 3 iterations.
- "Cancel pipeline" → Stop.

### STEP 5: Phase 5 — Step-by-Step Implementation + Review

Read `.task/plan.json` to get `total_steps`. Create per-step tasks:
```
For each step N (1..total_steps):
  TaskCreate({ subject: "Phase 5a: Implement step N - [title]", ... })  → T-impl-N
  TaskCreate({ subject: "Phase 5b: Review step N", ... })               → T-review-N, blockedBy T-impl-N
TaskCreate({ subject: "Phase 6: Final review", ... })                   → blockedBy last T-review-N
TaskCreate({ subject: "Phase 7: UI verification", ... })                → blockedBy Phase 6
```

**For each step N (1 to total_steps):**

**5a.** Mark T-impl-N as `in_progress`. Launch implementer:
```
Task({
  subagent_type: "aipilot:implementer",
  model: "opus",
  prompt: "<step_id>\nN\n</step_id>\n\nProject directory: <PROJECT_DIR>",
  description: "Implement step N"
})
```
Mark T-impl-N as `completed`.

**5b.** Mark T-review-N as `in_progress`. Run Codex:
```
Bash("node <PLUGIN_ROOT>/scripts/codex-review.js --type step-review --step-id N --plugin-root <PLUGIN_ROOT> --project-dir <PROJECT_DIR>")
```
Read `.task/step-N-review.json`. Mark T-review-N as `completed`.

- `approved` → Continue to step N+1
- `needs_changes` → Re-launch implementer with `<fix_findings>`, re-review with `--resume --changes-summary`. Max 3 iterations.
- `rejected` → Escalate to user.

**→ After ALL steps, write `.task/impl-result.json` combining all step results. IMMEDIATELY go to STEP 6.**

### STEP 6: Phase 6 — Final Review

Run Codex:
```
Bash("node <PLUGIN_ROOT>/scripts/codex-review.js --type final-review --plugin-root <PLUGIN_ROOT> --project-dir <PROJECT_DIR>")
```

- `approved` → Go to **STEP 7**.
- `needs_changes` → Launch implementer to fix, re-review. Max 3 iterations.

**→ YOUR NEXT ACTION: Go to STEP 7.**

### STEP 7: Phase 7 — UI Verification (conditional)

Only if `has_ui_changes: true` in `.task/impl-result.json`.

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

### STEP 8: Completion

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

### Agent Communication
- ALWAYS wrap agent input in the XML tags the agent expects: `<task_description>`, `<step_id>`, `<fix_findings>`, `<review_findings>`, `<verification_scope>`
- NEVER pass plain-text parameters
- NEVER write code or analyze the codebase yourself — delegate to agents
- NEVER stop between phases except at Phase 4 (User Review)
- NEVER summarize intermediate results — just proceed to the next step

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
