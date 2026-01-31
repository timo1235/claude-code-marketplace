# Claude Code Marketplace - Development Guide

## Project Structure

```
.claude-plugin/
  marketplace.json    # Marketplace registry (all plugins listed here)
plugins/
  <plugin-name>/
    .claude-plugin/
      plugin.json     # Plugin manifest
    skills/           # Skill definitions (optional)
    agents/           # Agent definitions (optional)
    hooks/            # Hook scripts (optional)
    CLAUDE.md         # Plugin-specific instructions
    README.md         # Plugin documentation
reference/            # Reference plugins for analysis (gitignored)
```

## Path Resolution

- `marketplace.json` uses `source` paths relative to its own location (prefix with `./`)
- `plugin.json` references paths relative to its own location
- Component directories (skills/, agents/, hooks/) are auto-discovered

## Adding a New Plugin

1. Create plugin directory under `plugins/<plugin-name>/`
2. Add `.claude-plugin/plugin.json` with plugin metadata
3. Register the plugin in `.claude-plugin/marketplace.json`
4. Update the README plugin table

## Development & Contributing

### Repository Location

Clone this repo to a regular project directory (e.g. alongside other projects), **not** inside
`~/.claude/plugins/marketplaces/`. That directory is managed by Claude Code and scanned at startup.
If the source repo lives there, plugins get loaded twice (installed copy + source copy), causing
duplicate hooks, CPU spikes, and broken behavior.

### Local Testing

Test a plugin locally without installing it using the `--plugin-dir` flag:

```bash
claude --plugin-dir /path/to/this-repo/plugins/<plugin-name>
```

This loads the plugin directly from source. Restart Claude Code to pick up changes.
Multiple plugins can be loaded at once by repeating the flag.

### Publishing Changes

After committing and pushing:

```bash
# Step 1: Update the marketplace registry (pulls latest git state)
claude plugin marketplace update timo1235-marketplace

# Step 2: Update the plugin
claude plugin update <plugin>@timo1235-marketplace

# Alternative if update doesn't pick up changes: full reinstall
claude plugin uninstall <plugin>@timo1235-marketplace
claude plugin install <plugin>@timo1235-marketplace
```

`plugin update` alone does NOT fetch new commits — it only checks the local marketplace cache.
You must run `plugin marketplace update` first to sync the registry, then `plugin update` to
install the new version.

Never edit files directly in `~/.claude/plugins/cache/` or `~/.claude/plugins/marketplaces/`.

### OpenAI Structured Output Schemas

Schemas under `docs/schemas/` are used by Codex CLI via `--output-schema`. They must conform to
OpenAI Structured Output restrictions:

- Every `object` must have `"additionalProperties": false`
- All properties must be listed in `required` (use `"type": ["string", "null"]` for optional fields)
- No `if`/`then`/`else` constructs
- `$ref` and `$defs` are supported
