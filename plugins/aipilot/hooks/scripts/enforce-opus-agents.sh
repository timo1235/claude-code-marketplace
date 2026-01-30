#!/usr/bin/env bash

# PreToolUse hook for Task tool:
# 1. Blocks aipilot agents if pipeline is not initialized (.task/state.json missing)
# 2. Blocks plan-reviewer/code-reviewer from being launched as Task subagents
# 3. Ensures Opus agents use the correct model
#
# Reads the Task tool input from stdin and checks parameters.

set -euo pipefail

INPUT=$(cat)

# Extract subagent_type from the tool input
SUBAGENT_TYPE=$(echo "$INPUT" | node -e "
  const data = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
  const input = data.tool_input || {};
  console.log(input.subagent_type || '');
" 2>/dev/null || echo "")

# Extract model from the tool input
MODEL=$(echo "$INPUT" | node -e "
  const data = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
  const input = data.tool_input || {};
  console.log(input.model || '');
" 2>/dev/null || echo "")

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
if [ "$IS_AIPILOT" = true ]; then
  PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
  STATE_FILE="$PROJECT_DIR/.task/state.json"

  if [ ! -f "$STATE_FILE" ]; then
    echo "{\"decision\": \"block\", \"reason\": \"AIPilot agents cannot be launched directly. Start the pipeline first using Skill(\\\"aipilot:pipeline\\\"). The pipeline skill handles initialization, Codex preflight check, and agent orchestration.\"}"
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
