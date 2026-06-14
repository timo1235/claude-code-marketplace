---
name: second-opinion
description: Get a second opinion from an alternative AI model when stuck on a problem. Collects context, invokes Codex via MCP (or falls back to Opus), and presents independent analysis.
plugin-scoped: true
allowed-tools: Read, Bash, Glob, Grep, Task, mcp__codex__codex
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
1. [Approach]: [what was done] -> [result/why it failed]
2. [Approach]: [what was done] -> [result/why it failed]

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

### Step 3a: Build Codex Prompt

Assemble a prompt containing:

1. The SECOND_OPINION_PROMPT (below)
2. The context string from Step 2 wrapped in `<context>` tags
3. Project directory: `${CLAUDE_PROJECT_DIR}`
4. Guardrail: "Only explore files within the project directory above. Do not access files outside the project."
5. The expected JSON output format

**SECOND_OPINION_PROMPT:**

```
You are a senior debugging specialist providing an independent second opinion. Another AI assistant has been working on this problem and is stuck. Your value comes from a fresh perspective — identify what was overlooked, not what was already tried.

<instructions>
The <context> block below provides an overview of the problem. You also have full read access to the project filesystem. Use it to explore beyond the provided context -- read imports, dependencies, test files, configuration, and any related code that could help diagnose the root cause. Only explore files within the project directory provided in your prompt. The more code you examine, the better your diagnosis will be.

1. Carefully read the provided context for the full problem description, prior attempts, errors, and relevant code
2. Identify assumptions in the prior attempts that may be incorrect
4. Formulate your own root cause hypothesis based on the evidence
5. Propose 3-4 alternative approaches ordered by confidence level
6. Assess the overall status: set 'resolved' if you have at least one high-confidence suggestion with strong code evidence, 'partially_resolved' if your best suggestion is medium confidence, 'requires_user_input' if all suggestions are speculative or you need more information from the user
7. For each suggestion, include concrete verification_steps — specific shell commands, test runs, or manual checks the developer can perform to confirm the fix works
8. Note any remaining_concerns — edge cases, caveats, environmental factors, or follow-up items that could affect the diagnosis. Set to null if none.

Focus your analysis on:
- Root causes the prior attempts may have missed (look for off-by-one layers: is the real bug one function/file/abstraction level away from where they looked?)
- Environmental or configuration factors that could explain the behavior
- Interactions between components that may not be obvious from reading individual files
- Whether the error message is misleading and the actual failure point is elsewhere
- **Explore the codebase**: Read related files (imports, callers, tests, config) within the project directory to find evidence for your hypotheses. Do not rely solely on the provided context snippets.

Rate each suggestion's confidence honestly: "high" only when you have strong evidence from the code, "medium" when the reasoning is sound but unverified, "low" for speculative ideas worth investigating.
</instructions>
```

**Output format instruction (append after context):**

```
Return your analysis as a single JSON object with these fields: source (set to "codex"), status (one of: resolved, partially_resolved, requires_user_input), problem_summary, analysis (minimum 20 characters), suggestions (array of objects with: approach, reasoning, confidence, verification_steps array), root_cause_hypothesis, remaining_concerns (string or null). Do not wrap in markdown code fences.
```

### Step 3b: Call Codex via MCP

Call:
```
mcp__codex__codex({ prompt: "<assembled prompt including project directory>" })
```

If the tool call fails (MCP server unavailable) -> go to Step 3d (Opus fallback).

### Step 3c: Extract and Validate JSON

Extract the JSON object from Codex's MCP response: find the outermost `{...}` structure in the response text.

If NO JSON can be extracted from the response -> tell user: "Codex returned non-JSON response, falling back to Opus." -> go to Step 3d (Opus fallback).

Pipe extracted JSON to validator via stdin heredoc:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-opinion.js" <<'JSON_EOF'
[extracted JSON here]
JSON_EOF
```

If validation succeeds (exit 0) -> capture stdout as the opinion JSON -> go to Step 4.

If validation fails (exit 1) -> read errors from stderr, try to fix the JSON (add missing fields with reasonable defaults based on response content), and re-validate by piping the fixed JSON via stdin again. Max 2 fix attempts.

If still invalid after 2 attempts -> tell user: "Codex response failed validation, falling back to Opus." -> go to Step 3d.

### Step 3d: Opus Fallback

Triggered by:
- MCP server unavailable
- Non-JSON response from Codex
- Validation failure after 2 fix attempts

```
Task({
  subagent_type: "second-opinion:opinion-presenter",
  model: "opus",
  prompt: "<context>\n[full context string from Step 2]\n</context>\n\nProject directory: ${CLAUDE_PROJECT_DIR}\n\nProvide your independent second opinion following the workflow in your agent instructions. Return your analysis as a JSON block.",
  description: "Get second opinion"
})
```

The agent returns the opinion as text in its response. Extract the JSON block (outermost `{...}`) and validate it using the same flow as Step 3c:

```
echo '<extracted JSON>' | node ${CLAUDE_PLUGIN_ROOT}/scripts/validate-opinion.js
```

If validation fails, fix the JSON based on the error output and re-validate. Max 2 attempts. If still invalid after 2 attempts, present the raw analysis text to the user without structured formatting.

## Step 4: Present Results

Parse the validated opinion JSON and present it in this format:

```
## Second Opinion (from [source])

**Status:** [status]

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
   **Verification:**
   [For each verification_step, as a bulleted list]

### Remaining Concerns
[remaining_concerns or 'None']
```

Based on the status field, provide a one-line actionable summary:
- resolved: 'The most likely fix is [approach 1]. Verify with [first verification_step].'
- partially_resolved: 'Start by investigating [approach 1] to narrow down the issue.'
- requires_user_input: 'More information is needed. The analysis is speculative.'

After presenting, assess the quality: If the analysis is generic (doesn't reference specific files or code), superficial (restates the problem without new insight), or contradicts observable evidence, tell the user that the opinion quality is limited and explain why.

<rules>
- Present the opinion to the user. Do not automatically implement any suggestions.
- Gather thorough context before invoking the model. A shallow context produces a shallow opinion.
- Run this once per invocation. Do not loop or retry the Codex MCP call with modified context.
- Do not write files to the project directory. All data flows through stdin/stdout pipes and MCP tool calls.
- If validation fails, you may attempt to fix the JSON and re-validate up to 2 times. Do not re-call Codex.
</rules>
