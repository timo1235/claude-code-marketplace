# Claude Code Marketplace

A collection of plugins for [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

## Marketplace zum Claude Code hinzufuegen

Im Terminal ausfuehren:

```bash
claude plugin marketplace add timo1235/claude-code-marketplace
```

Innerhalb einer Claude Code Session: `/plugins` eingeben und dort den Marketplace hinzufuegen.

## Verfuegbare Plugins

### Opus Pipeline

**Verzeichnis:** `plugins/opus-pipeline`

Ein Multi-AI-Orchestrierungspipeline-Plugin, das spezialisierte KI-Agenten durch einen strukturierten 7-Phasen-Workflow koordiniert.

#### Ueberblick

Das Plugin orchestriert verschiedene KI-Modelle in spezialisierten Rollen:

- **Opus** (Claude Opus 4.5): Planung, Implementierung und UI-Verifikation
- **Codex**: Plan- und Code-Review (Quality Gates)
- **User**: Finale Freigabe des Plans
- **Playwright MCP**: Visuelle UI-Verifikation

#### Pipeline-Phasen

| Phase | Agent | Beschreibung | Artefakte |
|-------|-------|-------------|-----------|
| 1. Analyse & Planung | Opus (Analyzer) | Analysiert die Codebase, erstellt Implementierungsplan | `.task/plan.md`, `.task/plan.json` |
| 2. Plan Review | Codex (via CLI) | Prueft Plan auf Korrektheit, Vollstaendigkeit, Sicherheit | `.task/plan-review.json` |
| 3. Plan Revision | Opus (Analyzer) | Ueberarbeitet Plan basierend auf Review-Ergebnissen (optional) | Aktualisierte Plan-Dateien |
| 4. User Review | Manuell | Benutzer prueft/editiert den Plan und gibt Freigabe | - |
| 5. Implementierung | Opus (Implementer) | Setzt Plan Schritt fuer Schritt um | Code-Aenderungen, `.task/impl-result.json` |
| 6. Code Review | Codex (via CLI) | Prueft alle Code-Aenderungen | `.task/code-review.json` |
| 7. UI Verifikation | Opus + Playwright | Visuelle Pruefung der UI-Aenderungen (optional) | `.task/ui-review.json`, Screenshots |

#### Agenten

| Agent | Modell | Aufgabe |
|-------|--------|---------|
| **analyzer** | Opus | Codebase-Analyse und Planerstellung |
| **plan-reviewer** | Codex | Plan-Validierung und Risikobewertung |
| **implementer** | Opus | Schrittweise Code-Implementierung |
| **code-reviewer** | Codex | Code-Qualitaetspruefung und Sicherheitsaudit |
| **ui-verifier** | Opus + Playwright | Visuelle UI-Verifikation mit Screenshots |

#### Verwendung

Pipeline starten mit dem Skill-Befehl:

```
/pipeline
```

Oder einfach sagen: "start pipeline", "plan and implement", etc.

#### Hooks

Das Plugin nutzt drei Hook-Typen:

- **UserPromptSubmit** (`phase-guidance.js`): Injiziert phasenspezifische Kontextinformationen
- **SubagentStop** (`review-gate.js`): Validiert Review-Ausgaben und erzwingt Quality Gates
- **PreToolUse** (`enforce-opus-agents.sh`): Stellt sicher, dass die richtigen Modelle fuer jeden Agenten verwendet werden

#### Iterationslimits

| Phase | Max. Iterationen | Bei Erschoepfung |
|-------|-----------------|-------------------|
| Plan Review | 3 | Eskalation an Benutzer |
| Code Review | 3 | Eskalation an Benutzer |
| UI Verifikation | 2 | Eskalation an Benutzer |

#### Voraussetzungen

- Claude Code CLI
- Codex CLI (optional, aber empfohlen fuer Reviews)
- Playwright MCP Plugin (fuer UI-Verifikation)
- Git Repository (fuer Diff-Tracking)

## Projektstruktur

```
plugins/
  opus-pipeline/
    .claude-plugin/
      plugin.json              # Plugin-Metadaten und Konfiguration
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
      codex-review.js          # Codex CLI Wrapper fuer Reviews
    skills/
      pipeline/
        SKILL.md               # Pipeline-Orchestrator-Skill
    AGENTS.md                  # Agenten-Spezifikationen
    CLAUDE.md                  # Plugin-Dokumentation
```

## Lizenz

MIT
