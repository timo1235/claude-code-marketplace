---
name: second-opinion
description: Get a second opinion from an alternative AI model when stuck on a problem. Collects context, invokes Codex CLI (or falls back to Opus), and presents independent analysis.
plugin-scoped: true
allowed-tools: Read, Bash, Glob, Grep, Write, Task
---

# Second Opinion

Get a fresh perspective from an alternative AI model when you're stuck.

**Plugin root:** `${CLAUDE_PLUGIN_ROOT}`
**Project dir:** `${CLAUDE_PROJECT_DIR}`
**Opinion dir:** `${CLAUDE_PROJECT_DIR}/.second-opinion/`

---

## Step 1: Gather Context

Analyze the current conversation and situation to understand:

1. **The problem**: What is the user trying to achieve? What's failing?
2. **What's been tried**: What approaches have already been attempted?
3. **Errors**: What error messages have appeared?
4. **Relevant files**: Which source files are involved?

Use Glob and Read to inspect the relevant code files. Collect all information needed for an independent analysis.

## Step 2: Write Context File

Write all gathered context to `.second-opinion/context.md` using the Write tool:

```markdown
# Second Opinion Request

## Problem
[Clear description of the problem]

## What Has Been Tried
[List of approaches attempted so far]

## Errors Encountered
[Error messages and their context]

## Relevant Code
[File paths and key code sections]

## Project Context
[Brief description of the project and relevant architecture]
```

Be thorough — this is the only information the alternative model will see.

## Step 3: Invoke Alternative Model

Run the opinion engine:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/get-opinion.js" --context-file "${CLAUDE_PROJECT_DIR}/.second-opinion/context.md" --project-dir "${CLAUDE_PROJECT_DIR}" --plugin-root "${CLAUDE_PLUGIN_ROOT}"
```

### Handle exit codes:

| Exit Code | Meaning | Action |
|-----------|---------|--------|
| 0 | Success | Go to Step 4 |
| 10 | Codex not available | Go to Step 3b (Opus fallback) |
| 4 | Locked | Tell user another opinion is in progress, try again later |
| Other | Error | Tell user the opinion generation failed |

## Step 3b: Opus Fallback

If Codex is not available (exit code 10), use the Opus subagent:

```
Task({ subagent_type: "second-opinion:opinion-presenter", model: "opus", prompt: "Project: ${CLAUDE_PROJECT_DIR}\n\nRead .second-opinion/context.md and provide your independent second opinion. Write result to .second-opinion/opinion.json.", description: "Get second opinion" })
```

## Step 4: Present Results

Read `.second-opinion/opinion.json` and present the results to the user in a clear, formatted way:

### Format:

```
## Second Opinion (from [source])

### Problem Summary
[problem_summary]

### Independent Analysis
[analysis]

### Root Cause Hypothesis
[root_cause_hypothesis]

### Suggested Approaches
1. **[approach]** (confidence: [confidence])
   [reasoning]
2. ...
```

## Rules

- **Do NOT automatically implement** any suggestions — only present them
- **Do NOT skip context gathering** — a thorough context file is critical for good results
- **Do NOT run this in a loop** — one opinion per invocation
- If the opinion seems low quality or generic, tell the user honestly
