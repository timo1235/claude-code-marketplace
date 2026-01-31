# Claude Code Marketplace - Development Guide

## Important: Development Location

This repo MUST live under `~/code/claude-code-marketplace/`, NOT under `~/.claude/plugins/marketplaces/`.
The `~/.claude/plugins/marketplaces/` directory is managed by Claude Code and scanned at startup.
If the source repo lives there, plugins get loaded twice (installed + source), causing duplicate
hooks, CPU spikes, and broken behavior.

## Local Testing

Test a plugin locally without installing it:

```bash
claude --plugin-dir ~/code/claude-code-marketplace/plugins/aipilot
```

This loads the plugin directly from source. Restart Claude Code to pick up changes.

## Publishing Changes

After committing and pushing changes:

```bash
claude plugin update aipilot@timo1235-marketplace
```

Or reinstall if update doesn't pick up changes:

```bash
claude plugin uninstall aipilot@timo1235-marketplace
claude plugin install aipilot@timo1235-marketplace
```

Never edit files directly in `~/.claude/plugins/cache/`.

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
