#!/usr/bin/env bash
# run-chunkhound.sh - Config discovery wrapper for ChunkHound MCP
#
# Guards: only starts if chunkhound is installed AND an index database exists.
#
# Searches for .chunkhound.json in multiple locations (LLM tool directories)
# and passes --config if found in non-standard location.
#
# Config locations (priority order, last wins):
#   - .chunkhound.json (project root - native ChunkHound discovery)
#   - .ai/.chunkhound.json
#   - .aider/.chunkhound.json
#   - .cursor/.chunkhound.json
#   - .kite/.chunkhound.json
#   - .llm/.chunkhound.json
#   - .tabnine/.chunkhound.json
#   - .claude/.chunkhound.json (Claude Code - highest priority)
#
# Environment variable override: CHUNKHOUND_CONFIG_FILE (takes precedence)

set -euo pipefail

# Get project root
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"

# --- Guard: only start if chunkhound is installed ---
if ! command -v chunkhound &>/dev/null; then
    exit 0
fi

# --- Resolve config file ---
# CHUNKHOUND_CONFIG_FILE takes precedence
CONFIG_FILE=""
if [[ -n "${CHUNKHOUND_CONFIG_FILE:-}" && -f "${CHUNKHOUND_CONFIG_FILE}" ]]; then
    CONFIG_FILE="${CHUNKHOUND_CONFIG_FILE}"
fi

# Otherwise scan known locations (last match wins)
if [[ -z "${CONFIG_FILE}" ]]; then
    CONFIG_LOCATIONS=(
        ".chunkhound.json"
        ".ai/.chunkhound.json"
        ".aider/.chunkhound.json"
        ".cursor/.chunkhound.json"
        ".kite/.chunkhound.json"
        ".llm/.chunkhound.json"
        ".tabnine/.chunkhound.json"
        ".claude/.chunkhound.json"
    )
    for location in "${CONFIG_LOCATIONS[@]}"; do
        full_path="${PROJECT_ROOT}/${location}"
        if [[ -f "${full_path}" ]]; then
            CONFIG_FILE="${full_path}"
        fi
    done
fi

# --- Extract database.path from config (default: .chunkhound) ---
db_path=""
if [[ -n "${CONFIG_FILE}" ]]; then
    # Try python3 first (widely available), then jq
    if command -v python3 &>/dev/null; then
        db_path=$(python3 -c "
import json, sys
try:
    cfg = json.load(open('${CONFIG_FILE}'))
    print(cfg.get('database', {}).get('path', ''))
except: pass
" 2>/dev/null || true)
    elif command -v jq &>/dev/null; then
        db_path=$(jq -r '.database.path // empty' "${CONFIG_FILE}" 2>/dev/null || true)
    fi
fi

# Default database path
if [[ -z "${db_path}" ]]; then
    db_path=".chunkhound"
fi

# Resolve relative path against project root
if [[ "${db_path}" != /* ]]; then
    db_path="${PROJECT_ROOT}/${db_path}"
fi

# --- Guard: only start if the index database directory exists ---
if [[ ! -d "${db_path}" ]]; then
    exit 0
fi

# --- Start MCP server ---
if [[ -n "${CONFIG_FILE}" && "${CONFIG_FILE}" != "${PROJECT_ROOT}/.chunkhound.json" ]]; then
    # Non-standard location found - pass explicit --config
    exec chunkhound mcp --config "${CONFIG_FILE}" "$@"
else
    # Project root config or no config - let ChunkHound use native discovery
    exec chunkhound mcp "$@"
fi
