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
| [aipilot](plugins/aipilot) | Productivity | Multi-Agent Pipeline: Opus plant und implementiert schrittweise, Codex reviewt jeden Step als Quality Gate, User gibt Plan frei. 7-Phasen-Workflow mit automatischer Fehlerkorrektur und optionaler Playwright UI-Verifikation. | [README](plugins/aipilot/README.md) |
| [second-opinion](plugins/second-opinion) | Productivity | Zweitmeinung bei festgefahrenen Problemen: `/second-opinion` sammelt Kontext und laesst Codex CLI (oder Opus als Fallback) unabhaengig analysieren. PostToolUse-Hook erkennt automatisch wiederholte Fehler und schlaegt Nutzung vor. | [README](plugins/second-opinion/README.md) |
| [chunkhound-integration](plugins/chunkhound-integration) | Code Intelligence | Semantische Code-Recherche mit ChunkHound: Multi-Hop-Suche, LLM-Synthese und architekturelle Analyse. Intelligentes Routing zwischen ChunkHound und nativen Tools. `/research` fuer explizite Nutzung, PreToolUse-Hook schlaegt ChunkHound bei architekturellen Grep-Queries vor. | [README](plugins/chunkhound-integration/README.md) |

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
