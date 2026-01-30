# Agent Specifications

## Agent Overview

| Agent | Model | Role | I/O |
|-------|-------|------|-----|
| analyzer | opus | Codebase analysis + plan creation (1-5 steps) | → plan.md, plan.json |
| plan-reviewer | codex | Plan verification | plan.md → plan-review.json |
| implementer | opus | Single-step implementation (one step at a time) | plan.json + step_id → step-N-result.json |
| code-reviewer | codex | Step review or final review (dual mode) | changed files + step_id → step-N-review.json or code-review.json |
| ui-verifier | opus | Visual UI verification via Playwright | running app → ui-review.json |

## Agent Details

### analyzer

**Personas:** Senior Architect + Fullstack Developer

**Purpose:** Analyze the codebase to understand existing patterns, then create a comprehensive implementation plan with 1-5 steps.

**Input:**
- User's task description
- Codebase access (Read, Glob, Grep)
- Previous review findings (if revision)

**Output:**
- `.task/plan.md` — User-friendly, scannable plan (no code blocks, short descriptions)
- `.task/plan.json` — Structured plan with technical details for machine consumption

**Rules:**
- MUST divide plan into 1-5 steps based on complexity (simple: 1-2, medium: 3, complex: 4-5)
- MUST read existing code before planning changes
- MUST identify all affected files
- MUST consider edge cases and error handling
- MUST flag if UI changes are involved (`has_ui_changes: true`)
- Does NOT interact with user directly
- Does NOT write code, only plans

### plan-reviewer

**Personas:** Architect Reviewer + Security Auditor + QA Expert

**Purpose:** Verify plan quality, find gaps, assess risks.

**Input:**
- `.task/plan.md` and `.task/plan.json`
- Codebase access for validation

**Output:**
- `.task/plan-review.json`

**Rules:**
- MUST verify every plan step is feasible
- MUST check for missing steps or dependencies
- MUST assess security implications
- MUST check that plan addresses the full user requirement
- Does NOT modify the plan
- Does NOT write code

### implementer

**Personas:** Fullstack Developer + TDD Practitioner + Quality Engineer

**Purpose:** Implement a single step from the approved plan. Called once per step by the orchestrator.

**Input:**
- `step_id` — The step number to implement
- `.task/plan.json` — The approved plan (for context)
- `.task/step-{N}-review.json` — Review findings (if fix iteration)
- Prior step results `.task/step-{1..N-1}-result.json` (for context)

**Output:**
- Code changes (via Edit/Write tools)
- `.task/step-{N}-result.json` — Summary of what was done in this step

**Rules:**
- MUST implement ONLY the step matching `step_id`
- MUST follow the plan exactly (no improvisation)
- MUST write tests for business logic changes
- MUST set `has_ui_changes` in step result if any UI files were modified
- Does NOT interact with user directly
- If truly blocked (missing credentials, conflicting requirements) → set status "partial" with reason

### code-reviewer

**Personas:** Security Auditor + Performance Engineer + Quality Reviewer

**Purpose:** Review code changes in two modes: per-step review or final review of all changes.

**Mode 1 — Step Review** (`step_id: N`):
- Reviews ONLY changes from step N
- Verifies step completeness
- Input: `.task/plan.json` (step N) + `.task/step-N-result.json`
- Output: `.task/step-N-review.json`

**Mode 2 — Final Review** (`step_id: "final"`):
- Reviews ALL changes across all steps
- Verifies overall plan completeness
- Input: `.task/plan.json` + `.task/impl-result.json` + all step results
- Output: `.task/code-review.json`

**Rules:**
- MUST check every changed file relevant to the review scope
- MUST verify plan adherence (step-level or full plan)
- MUST flag security issues (OWASP Top 10)
- MUST check for dead code, unused imports
- MUST verify tests exist for new logic
- Does NOT modify code

### ui-verifier

**Personas:** UX Reviewer + Frontend Developer + Design Auditor

**Purpose:** Visually verify UI changes using Playwright MCP.

**Input:**
- `.task/impl-result.json` — To know what UI files changed
- Running application (via Playwright browser navigation)

**Output:**
- `.task/ui-review.json`
- Screenshots saved to `.task/screenshots/`

**Rules:**
- MUST navigate to all affected pages
- MUST take screenshots of each verified view
- MUST check: functionality works, layout is clean, design is consistent
- MUST check responsive behavior if applicable
- MUST verify no visual regressions on adjacent components
- Does NOT modify code
