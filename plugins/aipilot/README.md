# AIPilot Plugin

Multi-Agent-Orchestrierungs-Plugin, das spezialisierte KI-Agenten durch einen strukturierten 7-Phasen-Workflow mit schrittweiser Implementierung und Per-Step Code Review koordiniert.

## Ueberblick

Das Plugin orchestriert verschiedene KI-Modelle in spezialisierten Rollen:

- **Opus** (Claude Opus 4.5): Planung, Implementierung und UI-Verifikation
- **Codex**: Plan- und Code-Review (Quality Gates)
- **User**: Finale Freigabe des Plans
- **Playwright MCP**: Visuelle UI-Verifikation

## Installation

```
claude plugin install aipilot@timo1235-marketplace
```

## Verwendung

Pipeline starten mit dem Skill-Befehl:

```
/pipeline
```

Oder einfach sagen: "start pipeline", "plan and implement", etc.

## Pipeline-Phasen

| Phase | Agent | Beschreibung | Artefakte |
|-------|-------|-------------|-----------|
| 1. Analyse & Planung | Opus (Analyzer) | Analysiert die Codebase, erstellt Implementierungsplan | `.task/plan.md`, `.task/plan.json` |
| 2. Plan Review | Codex (via MCP) | Prueft Plan auf Korrektheit, Vollstaendigkeit, Sicherheit | `.task/plan-review.json` |
| 3. Plan Revision | Opus (Analyzer) | Ueberarbeitet Plan basierend auf Review-Ergebnissen (optional) | Aktualisierte Plan-Dateien |
| 4. User Review | Manuell | Benutzer prueft/editiert den Plan und gibt Freigabe | - |
| 5. Schrittweise Implementierung | Opus (Implementer) + Codex (via MCP) | Pro Step: Opus implementiert, Codex reviewt (Fix-Loop bei Bedarf) | `.task/step-N-result.json`, `.task/step-N-review.json` |
| 6. Final Code Review | Codex (via MCP) | Prueft alle Aenderungen insgesamt auf Vollstaendigkeit | `.task/code-review.json` |
| 7. UI Verifikation | Opus + Playwright | Visuelle Pruefung der UI-Aenderungen (optional) | `.task/ui-review.json`, Screenshots |

## Agenten

| Agent | Modell | Aufgabe |
|-------|--------|---------|
| **analyzer** | Opus (Task Agent) | Codebase-Analyse und Planerstellung (1-5 Steps) |
| **plan-reviewer** | Codex MCP | Plan-Validierung und Risikobewertung |
| **implementer** | Opus (Task Agent) | Einzelschritt-Implementierung (ein Step pro Aufruf) |
| **code-reviewer** | Codex MCP | Step-Review oder Final-Review (zwei Modi) |
| **ui-verifier** | Opus (Task Agent) + Playwright | Visuelle UI-Verifikation mit Screenshots |

## Hooks

Das Plugin nutzt drei Hook-Typen:

- **UserPromptSubmit** (`phase-guidance.js`): Injiziert phasenspezifische Kontextinformationen
- **SubagentStop** (`review-gate.js`): Validiert Review-Ausgaben und erzwingt Quality Gates
- **PreToolUse** (`enforce-opus-agents.sh`): Stellt sicher, dass die richtigen Modelle fuer jeden Agenten verwendet werden

## Iterationslimits

| Phase | Max. Iterationen | Bei Erschoepfung |
|-------|-----------------|-------------------|
| Plan Review | 3 | Eskalation an Benutzer |
| User Plan Review | 3 | Eskalation an Benutzer |
| Per-Step Code Review | 3 pro Step | Eskalation an Benutzer |
| Final Code Review | 3 | Eskalation an Benutzer |
| UI Verifikation | 2 | Eskalation an Benutzer |

## Voraussetzungen

- Claude Code CLI
- Codex CLI (erforderlich fuer MCP Server und Reviews)
- Playwright MCP Plugin (fuer UI-Verifikation)
- Git Repository (fuer Diff-Tracking)

## Projektstruktur

```
.claude-plugin/
  plugin.json              # Plugin-Metadaten und Konfiguration
.mcp.json                  # MCP Server Konfiguration (Codex)
.task.template/
  state.json               # Template fuer Pipeline-State-Tracking
agents/
  analyzer.md              # Analyzer-Agent (Opus)
  code-reviewer.md         # Code-Reviewer-Agent (Codex)
  implementer.md           # Implementer-Agent (Opus)
  plan-reviewer.md         # Plan-Reviewer-Agent (Codex)
  ui-verifier.md           # UI-Verifier-Agent (Opus + Playwright)
docs/
  workflow.md              # Visuelles Pipeline-Workflow-Diagramm
hooks/
  hooks.json               # Hook-Konfiguration
  phase-guidance.js        # UserPromptSubmit Hook
  review-gate.js           # SubagentStop Hook
  scripts/
    enforce-opus-agents.sh # PreToolUse Hook
scripts/
  validate-review.js       # Review JSON Validation und Aggregation
skills/
  pipeline/
    SKILL.md               # Pipeline-Orchestrator-Skill
AGENTS.md                  # Agenten-Spezifikationen
CLAUDE.md                  # Plugin-Dokumentation
```

## Lizenz

MIT
