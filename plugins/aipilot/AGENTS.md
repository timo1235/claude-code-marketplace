@README.md

## Quick Reference

| Component | Purpose | File |
|-----------|---------|------|
| Analyzer agent | Codebase analysis + plan creation | agents/analyzer.md |
| Implementer agent | Single-step implementation | agents/implementer.md |
| UI Verifier agent | Playwright visual verification | agents/ui-verifier.md |
| Orchestrator skill | Pipeline coordination | skills/aipilot/SKILL.md |
| Pipeline Check cmd | Pre-flight verification | commands/pipeline-check.md |
| Phase Guidance hook | Advisory context injection | hooks/phase-guidance.js |
| Review Gate hook | Quality enforcement on SubagentStop | hooks/review-gate.js |
| Validate Review script | Review JSON validation + aggregation | scripts/validate-review.js |
| Orchestrator script | Init, reset, status, dry-run | scripts/orchestrator.sh |

## Directory & File Structure

```
plugins/aipilot/
├── .mcp.json
├── .claude-plugin/plugin.json
├── CLAUDE.md
├── AGENTS.md
├── README.md
├── agents/
│   ├── analyzer.md
│   ├── implementer.md
│   └── ui-verifier.md
├── commands/
│   └── pipeline-check.md
├── docs/
│   ├── codex-prompts/
│   │   ├── plan-reviewer.md
│   │   └── code-reviewer.md
│   ├── schemas/
│   │   ├── plan-review.schema.json
│   │   ├── step-review.schema.json
│   │   └── final-review.schema.json
│   ├── standards.md
│   ├── standards-prototype.md
│   └── workflow.md
├── hooks/
│   ├── hooks.json
│   ├── phase-guidance.js
│   └── review-gate.js
├── scripts/
│   ├── validate-review.js
│   └── orchestrator.sh
└── skills/
    └── aipilot/SKILL.md
```

## Key Navigation Points

| Task | Primary File | Section |
|------|-------------|---------|
| Modify pipeline phases | skills/aipilot/SKILL.md | Phase Reference |
| Change plan review criteria | docs/codex-prompts/plan-reviewer.md | Review Standards |
| Modify code review criteria | docs/codex-prompts/code-reviewer.md | Review Standards |
| Adjust review schemas | docs/schemas/*.schema.json | - |
| Change iteration limits | skills/aipilot/SKILL.md | Main Loop / Phase Reference |
| Modify phase detection | hooks/phase-guidance.js | detectPhase() |
| Change validation rules | hooks/review-gate.js | validate*() functions |
| Add orchestrator commands | scripts/orchestrator.sh | case statement at bottom |
| Modify Codex invocation | skills/aipilot/SKILL.md | Phase 2/5b/6 review sections |
| Validate review output | scripts/validate-review.js | validateOutput() / aggregateStepResults() |

## Integration Points

- **Codex MCP**: `.mcp.json` registers Codex as MCP server. Orchestrator calls `mcp__codex__codex` for reviews
- **Pipeline modes**: prototype vs production, read from .task/pipeline-config.json
- **Artifact-based phase detection**: hooks/phase-guidance.js reads .task/*.json files
- **Hook events**: UserPromptSubmit (advisory), SubagentStop (enforcement)
