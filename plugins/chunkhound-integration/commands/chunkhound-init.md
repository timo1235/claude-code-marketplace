---
name: chunkhound-init
description: Initialize ChunkHound for the current project (install, configure, index)
---

Initialize ChunkHound for the current project. Work through these steps in order, skipping any that are already satisfied.

## Step 1: Check Installation

Run `chunkhound --version` via Bash.

- **If installed**: Note the version and continue.
- **If not installed**: Ask the user if they want to install it, then run:
  ```bash
  uv tool install chunkhound
  ```
  If `uv` is not available, suggest `pip install chunkhound` or `pipx install chunkhound` as alternatives.

## Step 2: Check Existing Config

Search for `.chunkhound.json` in priority order: `.claude/.chunkhound.json`, `.chunkhound.json`, and other supported locations. If a config already exists, show its contents and ask the user if they want to keep it or create a new one.

## Step 3: Create Configuration

If no config exists (or user wants a new one), gather preferences using AskUserQuestion:

**Question 1 - Embedding Provider:**
- `voyageai` (Recommended) - Best quality, requires API key from https://dash.voyageai.com/
- `openai` - Requires OpenAI API key
- `ollama` - Local embeddings, no API key needed

**Question 2 - API Key** (skip for ollama):
Ask the user for their API key.

**Question 3 - Database location:**
- `.claude/.chunkhound` (Recommended) - Keeps Claude-related files together
- `.chunkhound` - ChunkHound default location

Then create the config file at `.claude/.chunkhound.json` (create `.claude/` directory if needed). Use this template, filling in the user's choices:

```json
{
  "database": {
    "provider": "duckdb",
    "path": "<chosen_path>"
  },
  "llm": {
    "provider": "claude-code-cli"
  },
  "embedding": {
    "provider": "<chosen_provider>",
    "api_key": "<user_api_key>"
  }
}
```

For ollama, omit the `api_key` field.

## Step 4: Run Indexing

Tell the user that indexing will now start. **Important**: If the config file is NOT at the project root (`.chunkhound.json`), you MUST pass `--config` with the full absolute path. ChunkHound only auto-discovers `.chunkhound.json` in the project root — it does not search subdirectories like `.claude/`.

```bash
# Config at project root - no flag needed:
chunkhound index

# Config in .claude/ or other subdirectory - explicit path required:
chunkhound index --config /absolute/path/to/.claude/.chunkhound.json
```

Use the actual path where the config was created in Step 3. This may produce substantial output. If it succeeds, confirm that the database directory was created.

After successful indexing, create the marker file that the MCP server guard checks:
```bash
# Write marker file so the MCP server knows this db was indexed (not just auto-created)
touch <database_directory>/.indexed
```
Where `<database_directory>` is the directory containing the DuckDB file (e.g. `.chunkhound/` or `.claude/.chunkhound/`).

## Step 5: Verify

After indexing completes, inform the user:

1. ChunkHound is ready to use.
2. The MCP server will be available after restarting Claude Code.
3. They can use `/research <question>` for semantic code search.
4. They can run `/chunkhound-status` to verify everything is working.

If the MCP server was not running when this command started (because the guards in `run-chunkhound.sh` prevented it), emphasize that a **restart of Claude Code is required** to activate the MCP server.
