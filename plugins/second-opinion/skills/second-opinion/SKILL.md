---
name: second-opinion
description: Get a second opinion from an alternative AI model when stuck on a problem. Collects context, invokes Codex CLI (or falls back to Opus), and presents independent analysis.
plugin-scoped: true
allowed-tools: Read, Bash, Glob, Grep, Task
---

# Second Opinion

Get an independent analysis from an alternative AI model when stuck on a problem.

**Plugin root:** `${CLAUDE_PLUGIN_ROOT}`
**Project dir:** `${CLAUDE_PROJECT_DIR}`

---

## Step 1: Gather Context

Build a complete picture of the situation by collecting these four elements:

### 1a. Problem Description
Identify from the conversation: What is the user trying to achieve? What is the expected behavior vs. actual behavior? Quote specific error messages verbatim.

### 1b. Prior Attempts
List every approach that has been tried in this conversation. For each, note what was done and why it failed or didn't resolve the issue.

### 1c. Relevant Code
Use Glob and Read to examine the source files involved. Include:
- The specific functions/classes where the error occurs
- Related configuration files, imports, and dependencies
- Any recent changes that might have introduced the issue

### 1d. Project Architecture
Briefly describe the project structure, tech stack, and how the affected components relate to each other.

## Step 2: Build Context String

Compose the context as a structured markdown string. Do NOT write it to a file.

```
# Second Opinion Request

## Problem
Expected behavior: [what should happen]
Actual behavior: [what happens instead]
Error message: [exact error, verbatim]

## Prior Attempts
1. [Approach]: [what was done] → [result/why it failed]
2. [Approach]: [what was done] → [result/why it failed]

## Relevant Code
### [file path]
[key code sections with line numbers]

### [file path]
[key code sections with line numbers]

## Project Context
Tech stack: [languages, frameworks, tools]
Architecture: [how components relate]
Recent changes: [anything that might be relevant]
```

Quality check before proceeding: Does the context contain enough information for someone with zero prior knowledge to understand and investigate the problem? If not, gather more details.

## Step 3: Invoke Alternative Model

Pipe the context string to the opinion engine via stdin using a heredoc:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/get-opinion.js" --project-dir "${CLAUDE_PROJECT_DIR}" --plugin-root "${CLAUDE_PLUGIN_ROOT}" <<'CONTEXT_EOF'
[context string here]
CONTEXT_EOF
```

The script prints the opinion JSON to stdout. No files are left behind.

### Handle exit codes:

| Exit Code | Meaning | Action |
|-----------|---------|--------|
| 0 | Success | Go to Step 4 (stdout contains the opinion JSON) |
| 10 | Codex not available | Go to Step 3b (Opus fallback) |
| 4 | Locked | Tell user another opinion is in progress, try again later |
| Other | Error | Tell user the opinion generation failed |

## Step 3b: Opus Fallback

If Codex is not available (exit code 10), pass the full context directly in the Task prompt:

```
Task({
  subagent_type: "second-opinion:opinion-presenter",
  model: "opus",
  prompt: "<context>\n[full context string from Step 2]\n</context>\n\nProject directory: ${CLAUDE_PROJECT_DIR}\n\nProvide your independent second opinion following the workflow in your agent instructions. Return your analysis as a JSON block.",
  description: "Get second opinion"
})
```

The agent returns the opinion as text in its response — parse the JSON block from it.

## Step 4: Present Results

Parse the opinion JSON (from stdout or Task result) and present it in this format:

```
## Second Opinion (from [source])

### Problem Summary
[problem_summary]

### Independent Analysis
[analysis]

### Root Cause Hypothesis
[root_cause_hypothesis]

### Suggested Approaches
[For each suggestion, ordered by confidence:]
1. **[approach]** (confidence: [confidence])
   [reasoning]
```

After presenting, assess the quality: If the analysis is generic (doesn't reference specific files or code), superficial (restates the problem without new insight), or contradicts observable evidence, tell the user that the opinion quality is limited and explain why.

<rules>
- Present the opinion to the user. Do not automatically implement any suggestions.
- Gather thorough context before invoking the model. A shallow context produces a shallow opinion.
- Run this once per invocation. Do not loop or retry with modified context.
- Do not write files. Context flows via stdin/prompt, results return via stdout/task-response.
</rules>
