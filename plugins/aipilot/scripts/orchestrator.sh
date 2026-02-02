#!/usr/bin/env bash
set -euo pipefail

# Pipeline orchestrator utility script.
# Usage:
#   bash orchestrator.sh init [--project-dir /path]     # reset + preflight (single init call)
#   bash orchestrator.sh reset [--project-dir /path]
#   bash orchestrator.sh status [--project-dir /path]
#   bash orchestrator.sh dry-run [--plugin-root /path]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
TASK_DIR=""
LOCK_FILE=""

# --- Argument Parsing ---

COMMAND="${1:-help}"
shift || true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-dir)
      PROJECT_DIR="$2"
      shift 2
      ;;
    --plugin-root)
      PLUGIN_ROOT="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

TASK_DIR="$PROJECT_DIR/.task"
LOCK_FILE="$PROJECT_DIR/.orchestrator.lock"

# --- Locking ---

acquire_lock() {
  if [ -f "$LOCK_FILE" ]; then
    local pid
    pid=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "ERROR: Another orchestrator is running (PID $pid). Remove $LOCK_FILE if stale." >&2
      exit 1
    fi
    echo "WARNING: Stale lock file found. Removing." >&2
    rm -f "$LOCK_FILE"
  fi
  echo $$ > "$LOCK_FILE"
  trap 'rm -f "$LOCK_FILE"' EXIT
}

# --- Reset ---

cmd_reset() {
  acquire_lock

  echo "Resetting pipeline artifacts in $TASK_DIR ..."

  if [ -d "$TASK_DIR" ]; then
    rm -rf "$TASK_DIR"
    echo "Removed .task/ directory."
  fi
  mkdir -p "$TASK_DIR"
  echo "Pipeline reset complete. Ready for a new run."
}

# --- Status ---

cmd_status() {
  if [ ! -d "$TASK_DIR" ]; then
    echo "No .task/ directory found. Pipeline has not been initialized."
    exit 0
  fi

  echo "=== Pipeline Status ==="
  echo "Project: $PROJECT_DIR"
  echo ""

  # Artifact-based phase detection (mirrors phase-guidance.js logic)
  local plan_md="$TASK_DIR/plan.md"
  local plan_json="$TASK_DIR/plan.json"
  local plan_review="$TASK_DIR/plan-review.json"
  local impl_result="$TASK_DIR/impl-result.json"
  local code_review="$TASK_DIR/code-review.json"
  local ui_review="$TASK_DIR/ui-review.json"

  if [ -f "$ui_review" ]; then
    echo "Phase: 7 - UI Verification"
    echo "Status: $(node -e "console.log(JSON.parse(require('fs').readFileSync('$ui_review','utf8')).status)" 2>/dev/null || echo 'unknown')"
  elif [ -f "$code_review" ]; then
    echo "Phase: 6 - Final Review"
    echo "Status: $(node -e "console.log(JSON.parse(require('fs').readFileSync('$code_review','utf8')).status)" 2>/dev/null || echo 'unknown')"
  elif [ -f "$impl_result" ]; then
    echo "Phase: 5 - Implementation Complete"
    echo "Status: $(node -e "console.log(JSON.parse(require('fs').readFileSync('$impl_result','utf8')).status)" 2>/dev/null || echo 'unknown')"
  elif ls "$TASK_DIR"/step-*-result.json >/dev/null 2>&1 || ls "$TASK_DIR"/step-*-review.json >/dev/null 2>&1; then
    echo "Phase: 5 - Implementation In Progress"
    local step_results
    step_results=$(ls "$TASK_DIR"/step-*-result.json 2>/dev/null | wc -l)
    local step_reviews
    step_reviews=$(ls "$TASK_DIR"/step-*-review.json 2>/dev/null | wc -l)
    echo "Step results: $step_results | Step reviews: $step_reviews"
  elif [ -f "$plan_review" ]; then
    local review_status
    review_status=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$plan_review','utf8')).status)" 2>/dev/null || echo 'unknown')
    if [ "$review_status" = "approved" ]; then
      echo "Phase: 4 - User Review (plan approved by Codex)"
    elif [ "$review_status" = "needs_changes" ]; then
      echo "Phase: 3 - Plan Revision (needs changes)"
    else
      echo "Phase: 2 - Plan Review (status: $review_status)"
    fi
  elif [ -f "$plan_md" ] && [ -f "$plan_json" ]; then
    echo "Phase: 2 - Plan Review (awaiting Codex review)"
  else
    echo "Phase: 1 - Analyzing (no plan artifacts yet)"
  fi

  echo ""
  echo "=== Artifacts ==="
  for f in "$TASK_DIR"/*.json "$TASK_DIR"/*.md; do
    if [ -f "$f" ]; then
      local size
      size=$(wc -c < "$f")
      local mtime
      mtime=$(stat -c '%Y' "$f" 2>/dev/null || stat -f '%m' "$f" 2>/dev/null || echo '?')
      echo "  $(basename "$f") (${size}B, modified: $(date -d "@$mtime" '+%H:%M:%S' 2>/dev/null || echo "$mtime"))"
    fi
  done

}

# --- Dry Run ---

cmd_dry_run() {
  echo "=== Pipeline Dry Run ==="
  echo "Plugin root: $PLUGIN_ROOT"
  echo "Project dir: $PROJECT_DIR"
  echo ""

  local errors=0

  # Check scripts
  echo "--- Scripts ---"
  for script in validate-review.js; do
    local spath="$PLUGIN_ROOT/scripts/$script"
    if [ -f "$spath" ]; then
      echo "  OK  $script"
    else
      echo "  FAIL  $script (not found at $spath)"
      errors=$((errors + 1))
    fi
  done

  # Check agents directory
  echo ""
  echo "--- Agents ---"
  local agents_dir="$PLUGIN_ROOT/agents"
  if [ -d "$agents_dir" ]; then
    for agent_file in "$agents_dir"/*.md; do
      if [ -f "$agent_file" ]; then
        echo "  OK  $(basename "$agent_file")"
      fi
    done
  else
    echo "  WARN  No agents/ directory found"
  fi

  # Check schemas
  echo ""
  echo "--- Schemas ---"
  local schemas_dir="$PLUGIN_ROOT/docs/schemas"
  if [ -d "$schemas_dir" ]; then
    for schema in plan-review.schema.json step-review.schema.json final-review.schema.json; do
      if [ -f "$schemas_dir/$schema" ]; then
        echo "  OK  $schema"
      else
        echo "  WARN  $schema (not found)"
      fi
    done
  else
    echo "  WARN  No docs/schemas/ directory"
  fi

  # Check Codex prompts
  echo ""
  echo "--- Codex Prompts ---"
  local prompts_dir="$PLUGIN_ROOT/docs/codex-prompts"
  if [ -d "$prompts_dir" ]; then
    for prompt in plan-reviewer.md code-reviewer.md; do
      if [ -f "$prompts_dir/$prompt" ]; then
        echo "  OK  $prompt"
      else
        echo "  WARN  $prompt (not found)"
      fi
    done
  else
    echo "  WARN  No docs/codex-prompts/ directory"
  fi

  # Check CLI tools
  echo ""
  echo "--- CLI Tools ---"
  for tool in node codex; do
    if command -v "$tool" >/dev/null 2>&1; then
      local version
      version=$("$tool" --version 2>/dev/null | head -1 || echo "unknown")
      echo "  OK  $tool ($version)"
    else
      if [ "$tool" = "codex" ]; then
        echo "  WARN  $tool (needed for MCP server)"
        # Codex is optional; don't increment errors
      else
        echo "  FAIL  $tool (required)"
        errors=$((errors + 1))
      fi
    fi
  done

  # Check hooks
  echo ""
  echo "--- Hooks ---"
  local hooks_json="$PLUGIN_ROOT/hooks/hooks.json"
  if [ -f "$hooks_json" ]; then
    echo "  OK  hooks.json"
    for hook in phase-guidance.js review-gate.js; do
      if [ -f "$PLUGIN_ROOT/hooks/$hook" ]; then
        echo "  OK  $hook"
      else
        echo "  WARN  $hook (not found)"
      fi
    done
  else
    echo "  WARN  hooks.json not found"
  fi

  # Check standards
  echo ""
  echo "--- Standards ---"
  local standards="$PLUGIN_ROOT/docs/standards.md"
  if [ -f "$standards" ]; then
    echo "  OK  standards.md"
  else
    echo "  WARN  standards.md (not found)"
  fi

  # MCP Configuration check
  echo ""
  echo "--- MCP Configuration ---"
  if [ -f "$PLUGIN_ROOT/.mcp.json" ]; then
    echo "  OK  .mcp.json"
    if grep -q 'disk-full-read-access' "$PLUGIN_ROOT/.mcp.json"; then
      echo "  OK  sandbox_permissions includes disk-full-read-access"
    else
      echo "  WARN  .mcp.json missing disk-full-read-access sandbox permission (Codex cannot read files)"
    fi
  else
    echo "  FAIL  .mcp.json (not found -- Codex MCP server not configured)"
    errors=$((errors + 1))
  fi

  echo ""
  if [ "$errors" -eq 0 ]; then
    echo "=== Dry run PASSED ==="
    exit 0
  else
    echo "=== Dry run FAILED ($errors error(s)) ==="
    exit 1
  fi
}

# --- Help ---

cmd_help() {
  echo "Usage: orchestrator.sh <command> [options]"
  echo ""
  echo "Commands:"
  echo "  init      Reset pipeline + run preflight check (use this to start)"
  echo "  reset     Remove all .task/ artifacts and session markers"
  echo "  status    Show current pipeline phase (artifact-based)"
  echo "  dry-run   Validate setup: scripts, agents, schemas, CLI tools"
  echo "  help      Show this help"
  echo ""
  echo "Options:"
  echo "  --project-dir /path    Project directory (default: \$CLAUDE_PROJECT_DIR or cwd)"
  echo "  --plugin-root /path    Plugin root directory (default: auto-detected)"
}

# --- Init (reset + preflight in one call) ---

cmd_init() {
  acquire_lock

  echo "=== Pipeline Init ==="
  echo "Project: $PROJECT_DIR"
  echo ""

  # Step 1: Reset — clean slate for new pipeline run
  if [ -d "$TASK_DIR" ]; then
    rm -rf "$TASK_DIR"
    echo "Reset: removed existing .task/ directory."
  fi
  mkdir -p "$TASK_DIR"

  # Step 2: Preflight check
  echo ""
  echo "--- Preflight ---"
  if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found"
    exit 1
  fi
  echo "  OK  node ($(node --version 2>/dev/null))"

  # Check Codex MCP configuration
  if [ -f "$PLUGIN_ROOT/.mcp.json" ]; then
    echo "  OK  .mcp.json found (Codex MCP server configured)"
    if grep -q 'disk-full-read-access' "$PLUGIN_ROOT/.mcp.json"; then
      echo "  OK  sandbox_permissions includes disk-full-read-access"
    else
      echo "  WARN  .mcp.json missing disk-full-read-access sandbox permission (Codex cannot read files)"
    fi
  else
    echo "  WARN  .mcp.json not found (Codex reviews will not work)"
  fi
  if command -v codex >/dev/null 2>&1; then
    echo "  OK  codex CLI on PATH ($(codex --version 2>/dev/null | head -1))"
  else
    echo "  WARN  codex CLI not found (MCP server needs codex installed)"
  fi

  echo ""
  echo "=== Init complete. Create task chain with TaskCreate next. ==="
}

# --- Main ---

case "$COMMAND" in
  init)     cmd_init ;;
  reset)    cmd_reset ;;
  status)   cmd_status ;;
  dry-run)  cmd_dry_run ;;
  help|--help|-h) cmd_help ;;
  *)
    echo "Unknown command: $COMMAND" >&2
    cmd_help >&2
    exit 1
    ;;
esac
