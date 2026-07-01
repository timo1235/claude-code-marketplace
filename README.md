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
| [subagent-fleet](plugins/subagent-fleet) | Productivity | Orchestrator auf dem Frontier-Model, Ausfuehrung auf guenstigen Fremdprovider-Workern (z.ai/GLM, DeepSeek, OpenRouter): delegiert Tasks per Config an headless `claude -p`-Worker und reviewt deren Ergebnis. | [README](plugins/subagent-fleet/README.md) |

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
