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
