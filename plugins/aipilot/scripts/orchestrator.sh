#!/usr/bin/env bash
set -euo pipefail

# Pipeline orchestrator utility script.
# Usage:
#   bash orchestrator.sh init [--project-dir /path] [--session-id <id>]
#   bash orchestrator.sh reset [--project-dir /path] [--session-id <id>] [--all] [--force]
#   bash orchestrator.sh status [--project-dir /path] [--session-id <id>]
#   bash orchestrator.sh dry-run [--plugin-root /path]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
TASK_DIR=""
LOCK_FILE=""
SESSION_ID=""
RESET_ALL=false
RESET_FORCE=false

# --- Structured Logging ---

log_info()  { echo "[INFO] [session=${SESSION_ID:-none}] $*"; }
log_warn()  { echo "[WARN] [session=${SESSION_ID:-none}] $*" >&2; }
log_error() { echo "[ERROR] [session=${SESSION_ID:-none}] $*" >&2; }

# --- Session ID Validation ---

validate_session_id() {
  local id="$1"
  if [[ ! "$id" =~ ^[a-f0-9]{6}$ ]]; then
    log_error "Invalid session ID '$id'. Must match ^[a-f0-9]{6}$."
    exit 1
  fi
}

# --- Session ID Generation ---

generate_session_id() {
  local id
  if command -v openssl >/dev/null 2>&1; then
    id=$(openssl rand -hex 3 | tr '[:upper:]' '[:lower:]')
  elif command -v od >/dev/null 2>&1; then
    id=$(od -An -tx1 -N3 /dev/urandom | tr -d ' \n' | tr '[:upper:]' '[:lower:]')
  else
    log_error "Cannot generate session ID. Install openssl or ensure od is available."
    exit 1
  fi
  echo "$id"
}

# --- Session Discovery ---

discover_latest_session() {
  local latest_dir=""
  local latest_ts=0
  local valid_count=0

  for entry in "$PROJECT_DIR"/.task-*; do
    [ -d "$entry" ] || continue
    # Skip symlinks
    if [ -L "$entry" ]; then
      log_warn "Skipping symlink: $entry"
      continue
    fi
    local basename
    basename=$(basename "$entry")
    local id="${basename#.task-}"
    # Validate format
    if [[ ! "$id" =~ ^[a-f0-9]{6}$ ]]; then
      log_warn "Skipping invalid session dir: $entry"
      continue
    fi
    # Verify realpath stays under PROJECT_DIR
    local resolved
    resolved=$(realpath "$entry" 2>/dev/null || echo "")
    if [[ -z "$resolved" || ( "$resolved" != "$PROJECT_DIR"/* && "$resolved" != "$PROJECT_DIR" ) ]]; then
      log_warn "Skipping dir outside project: $entry"
      continue
    fi
    valid_count=$((valid_count + 1))
    # Check timestamp file, fall back to dir mtime
    local ts_file="$entry/.session-ts"
    local ts
    if [ -f "$ts_file" ]; then
      ts=$(cat "$ts_file" 2>/dev/null || echo "0")
    else
      ts=$(stat -c '%Y' "$entry" 2>/dev/null || stat -f '%m' "$entry" 2>/dev/null || echo "0")
    fi
    if [ "$ts" -gt "$latest_ts" ] 2>/dev/null; then
      latest_ts="$ts"
      latest_dir="$entry"
    elif [ "$ts" -eq "$latest_ts" ] 2>/dev/null && [ -n "$latest_dir" ]; then
      # Deterministic tie-break: lexicographically higher session ID wins
      if [ "$entry" \> "$latest_dir" ]; then
        latest_dir="$entry"
      fi
    fi
  done

  if [ -n "$latest_dir" ] && [ "$valid_count" -gt 1 ]; then
    log_warn "Multiple sessions found ($valid_count). Using latest: $(basename "$latest_dir"). Use --session-id for explicit selection."
  fi
  echo "$latest_dir"
}

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
    --session-id)
      SESSION_ID="$2"
      shift 2
      ;;
    --all)
      RESET_ALL=true
      shift
      ;;
    --force)
      RESET_FORCE=true
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# Resolve TASK_DIR based on session ID
if [ -n "$SESSION_ID" ]; then
  validate_session_id "$SESSION_ID"
  TASK_DIR="$PROJECT_DIR/.task-$SESSION_ID"
fi
LOCK_FILE="$PROJECT_DIR/.orchestrator.lock"

# --- Locking ---

acquire_lock() {
  # Use mkdir for atomic lock acquisition (mkdir is atomic on all POSIX systems)
  # Note: LOCK_DIR must NOT be local — the EXIT trap references it after the function returns
  LOCK_DIR="${LOCK_FILE}.d"
  local lock_dir="$LOCK_DIR"
  if mkdir "$lock_dir" 2>/dev/null; then
    echo $$ > "$LOCK_FILE"
    trap 'rm -f "$LOCK_FILE"; rmdir "$LOCK_DIR" 2>/dev/null' EXIT
    return
  fi
  # Lock dir exists — check if holder is still alive
  local pid
  pid=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    log_error "Another orchestrator is running (PID $pid). Remove $LOCK_FILE if stale."
    exit 1
  fi
  log_warn "Stale lock found. Removing."
  rm -f "$LOCK_FILE"
  rmdir "$lock_dir" 2>/dev/null
  # Retry once
  if mkdir "$lock_dir" 2>/dev/null; then
    echo $$ > "$LOCK_FILE"
    trap 'rm -f "$LOCK_FILE"; rmdir "$LOCK_DIR" 2>/dev/null' EXIT
    return
  fi
  log_error "Failed to acquire lock after retry."
  exit 1
}

# --- Reset ---

cmd_reset() {
  acquire_lock

  if [ "$RESET_ALL" = true ]; then
    log_info "Resetting ALL pipeline sessions ..."
    shopt -s nullglob
    local deleted=0
    local skipped=0
    for entry in "$PROJECT_DIR"/.task-*; do
      [ -d "$entry" ] || continue
      # Skip symlinks
      if [ -L "$entry" ]; then
        log_warn "Skipping symlink: $entry"
        skipped=$((skipped + 1))
        continue
      fi
      local basename
      basename=$(basename "$entry")
      local id="${basename#.task-}"
      # Validate format
      if [[ ! "$id" =~ ^[a-f0-9]{6}$ ]]; then
        log_warn "Skipping invalid session dir: $entry"
        skipped=$((skipped + 1))
        continue
      fi
      # Verify realpath stays under PROJECT_DIR
      local resolved
      resolved=$(realpath "$entry" 2>/dev/null || echo "")
      if [[ -z "$resolved" || ( "$resolved" != "$PROJECT_DIR"/* && "$resolved" != "$PROJECT_DIR" ) ]]; then
        log_warn "Skipping dir outside project: $entry"
        skipped=$((skipped + 1))
        continue
      fi
      # Active session check (unless --force)
      if [ "$RESET_FORCE" != true ] && [ -f "$LOCK_FILE" ]; then
        local lock_pid
        lock_pid=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
        if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null && [ "$$" != "$lock_pid" ]; then
          log_warn "Skipping active session dir: $entry (PID $lock_pid alive)"
          skipped=$((skipped + 1))
          continue
        fi
      fi
      rm -rf -- "$entry"
      log_info "Removed $basename"
      deleted=$((deleted + 1))
    done
    shopt -u nullglob
    log_info "Reset complete. Deleted: $deleted, Skipped: $skipped"
    return
  fi

  # Single session reset
  if [ -z "$TASK_DIR" ]; then
    # No session ID provided; discover latest
    TASK_DIR=$(discover_latest_session)
    if [ -z "$TASK_DIR" ]; then
      log_info "No active sessions found. Nothing to reset."
      return
    fi
    SESSION_ID=$(basename "$TASK_DIR" | sed 's/^\.task-//')
  fi

  log_info "Resetting pipeline artifacts in $TASK_DIR ..."

  if [ -d "$TASK_DIR" ]; then
    rm -rf -- "$TASK_DIR"
    log_info "Removed $(basename "$TASK_DIR") directory."
  fi
  mkdir -p "$TASK_DIR"
  date +%s > "$TASK_DIR/.session-ts"
  log_info "Pipeline reset complete. Ready for a new run."
}

# --- Status ---

cmd_status() {
  if [ -z "$TASK_DIR" ]; then
    # No session ID provided; discover latest
    TASK_DIR=$(discover_latest_session)
    if [ -z "$TASK_DIR" ]; then
      echo "No active sessions found."
      exit 0
    fi
    SESSION_ID=$(basename "$TASK_DIR" | sed 's/^\.task-//')
  fi

  if [ ! -d "$TASK_DIR" ]; then
    echo "Session directory not found: $TASK_DIR"
    exit 0
  fi

  echo "=== Pipeline Status ==="
  echo "Project: $PROJECT_DIR"
  echo "Session: $SESSION_ID ($(basename "$TASK_DIR"))"
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
    echo "Status: $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).status)' "$ui_review" 2>/dev/null || echo 'unknown')"
  elif [ -f "$code_review" ]; then
    echo "Phase: 6 - Final Review"
    echo "Status: $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).status)' "$code_review" 2>/dev/null || echo 'unknown')"
  elif [ -f "$impl_result" ]; then
    echo "Phase: 5 - Implementation Complete"
    echo "Status: $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).status)' "$impl_result" 2>/dev/null || echo 'unknown')"
  elif ls "$TASK_DIR"/step-*-result.json >/dev/null 2>&1 || ls "$TASK_DIR"/step-*-review.json >/dev/null 2>&1; then
    echo "Phase: 5 - Implementation In Progress"
    local step_results
    step_results=$(ls "$TASK_DIR"/step-*-result.json 2>/dev/null | wc -l)
    local step_reviews
    step_reviews=$(ls "$TASK_DIR"/step-*-review.json 2>/dev/null | wc -l)
    echo "Step results: $step_results | Step reviews: $step_reviews"
  elif [ -f "$plan_review" ]; then
    local review_status
    review_status=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).status)' "$plan_review" 2>/dev/null || echo 'unknown')
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
  echo "  init      Initialize a new pipeline session (generates session ID)"
  echo "  reset     Remove session artifacts (default: latest session)"
  echo "  status    Show current pipeline phase (default: latest session)"
  echo "  dry-run   Validate setup: scripts, agents, schemas, CLI tools"
  echo "  help      Show this help"
  echo ""
  echo "Options:"
  echo "  --project-dir /path       Project directory (default: \$CLAUDE_PROJECT_DIR or cwd)"
  echo "  --plugin-root /path       Plugin root directory (default: auto-detected)"
  echo "  --session-id <hex6>       Explicit 6-char hex session ID (default: auto-generated on init, auto-discovered otherwise)"
  echo ""
  echo "Reset options:"
  echo "  --all                     Remove ALL session directories (.task-*)"
  echo "  --force                   Force removal even if sessions appear active"
}

# --- Init (reset + preflight in one call) ---

cmd_init() {
  acquire_lock

  # Generate session ID if not provided
  if [ -z "$SESSION_ID" ]; then
    SESSION_ID=$(generate_session_id)
  fi
  validate_session_id "$SESSION_ID"
  TASK_DIR="$PROJECT_DIR/.task-$SESSION_ID"

  log_info "=== Pipeline Init ==="
  log_info "Project: $PROJECT_DIR"
  log_info "Session: $SESSION_ID"

  # Step 1: Reset — clean slate for this session
  if [ -d "$TASK_DIR" ]; then
    rm -rf -- "$TASK_DIR"
    log_info "Reset: removed existing $(basename "$TASK_DIR") directory."
  fi
  mkdir -p "$TASK_DIR"
  date +%s > "$TASK_DIR/.session-ts"

  # Step 2: Preflight check
  echo ""
  echo "--- Preflight ---"
  if ! command -v node >/dev/null 2>&1; then
    log_error "FAIL: node not found"
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
  echo ""
  echo "SESSION_ID=$SESSION_ID"
  echo "TASK_DIR=$TASK_DIR"
  echo "export AIPILOT_SESSION_ID=$SESSION_ID"
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
