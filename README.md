# Claude Code Marketplace

A collection of plugins for [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

## Installation

Innerhalb einer Claude Code Session:

```
/plugin marketplace add timo1235/claude-code-marketplace
```

Oder im Terminal:

```bash
claude plugin marketplace add timo1235/claude-code-marketplace
```

Danach Plugins durchsuchen und installieren mit `/plugin`.

## Verfuegbare Plugins

| Plugin | Kategorie | Beschreibung | Details |
|--------|-----------|-------------|---------|
| [fable-orchestrator](plugins/fable-orchestrator) | Productivity | Fable als Orchestrator: plant, reviewt und integriert selbst, delegiert die Ausfuehrung nach Komplexitaet an guenstigere Subagents (grunt-worker/haiku, task-implementer/sonnet, heavy-lift/opus), um Token zu sparen. | [README](plugins/fable-orchestrator/README.md) |

## Plugin-Struktur

```
.claude-plugin/
  marketplace.json          # Marketplace-Registry
plugins/
  <plugin-name>/
    .claude-plugin/
      plugin.json           # Plugin-Manifest
    skills/                 # Skills (optional)
    agents/                 # Agenten (optional)
    hooks/                  # Hooks (optional)
```

## Lizenz

MIT
