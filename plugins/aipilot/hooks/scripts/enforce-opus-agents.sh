#!/usr/bin/env bash

# PreToolUse hook for Task tool:
# 1. Blocks aipilot agents if pipeline-tasks.json is missing (initialization not complete)
# 2. Blocks plan-reviewer/code-reviewer from being launched as Task subagents
# 3. Ensures Opus agents use the correct model
#
# Reads the Task tool input from stdin and checks parameters.

set -euo pipefail

INPUT=$(cat)

# Extract subagent_type and model from the tool input (single node call)
PARSED=$(echo "$INPUT" | node -e "
  const data = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
  const input = data.tool_input || {};
  console.log((input.subagent_type || '') + '\n' + (input.model || ''));
" 2>/dev/null || echo -e "\n")

SUBAGENT_TYPE=$(echo "$PARSED" | head -1)
MODEL=$(echo "$PARSED" | tail -1)

# Check if this is an aipilot agent
IS_AIPILOT=false
AIPILOT_AGENTS="analyzer implementer ui-verifier aipilot:analyzer aipilot:implementer aipilot:ui-verifier"
for agent in $AIPILOT_AGENTS; do
  if [ "$SUBAGENT_TYPE" = "$agent" ]; then
    IS_AIPILOT=true
    break
  fi
done

# Block aipilot agents if pipeline is not initialized
# Gate on pipeline-tasks.json (created during Step 5 of initialization)
if [ "$IS_AIPILOT" = true ]; then
  PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
  PIPELINE_TASKS="$PROJECT_DIR/.task/pipeline-tasks.json"

  if [ ! -f "$PIPELINE_TASKS" ]; then
    echo "{\"decision\": \"block\", \"reason\": \"Pipeline not initialized: .task/pipeline-tasks.json missing. Complete ALL initialization steps first (reset, preflight, task chain, write pipeline-tasks.json). Use Skill(\\\"aipilot:pipeline\\\") to start properly.\"}"
    exit 0
  fi

  # Validate pipeline-tasks.json has required keys
  VALID=$(node -e "
    try {
      const j = JSON.parse(require('fs').readFileSync('$PIPELINE_TASKS', 'utf8'));
      const ok = j.phase1 && j.phase2 && j.phase3 && j.phase4;
      console.log(ok ? 'yes' : 'no');
    } catch { console.log('no'); }
  " 2>/dev/null || echo "no")

  if [ "$VALID" != "yes" ]; then
    echo "{\"decision\": \"block\", \"reason\": \"pipeline-tasks.json is incomplete — missing required phase keys. Re-run initialization to create the full task chain.\"}"
    exit 0
  fi
fi

# Block reviewers from being launched as Task subagents — they run via Codex CLI
BLOCKED_AGENTS="plan-reviewer code-reviewer aipilot:plan-reviewer aipilot:code-reviewer"
for agent in $BLOCKED_AGENTS; do
  if [ "$SUBAGENT_TYPE" = "$agent" ]; then
    echo "{\"decision\": \"block\", \"reason\": \"'$SUBAGENT_TYPE' must NOT be launched as a Task subagent. Run reviews via Bash: node <plugin-root>/scripts/codex-review.js --type plan|step-review|final-review\"}"
    exit 0
  fi
done

# Agents that MUST use Opus
OPUS_AGENTS="analyzer implementer ui-verifier general-purpose"

for agent in $OPUS_AGENTS; do
  if [ "$SUBAGENT_TYPE" = "$agent" ] && [ -n "$MODEL" ] && [ "$MODEL" != "opus" ]; then
    echo "{\"decision\": \"block\", \"reason\": \"Agent '$SUBAGENT_TYPE' must use model 'opus', but '$MODEL' was specified. Set model to 'opus'.\"}"
    exit 0
  fi
done

exit 0
