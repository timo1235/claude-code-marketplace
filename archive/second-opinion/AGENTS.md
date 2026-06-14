@README.md

## Quick Reference

| Component | Purpose | File |
|-----------|---------|------|
| Opinion Presenter agent | Opus fallback analysis | agents/opinion-presenter.md |
| Second Opinion skill | Main orchestration | skills/second-opinion/SKILL.md |
| Stuck Detector hook | Error pattern detection | hooks/stuck-detector.js |
| Validate Opinion script | Output JSON validator | scripts/validate-opinion.js |
| Schema | Output validation | docs/schemas/second-opinion.schema.json |

**Agent Configuration:**
- **Model**: opus (fallback only; primary path uses Codex MCP)
- **Color**: yellow
- **Tools**: Read, Glob, Grep

## Directory & File Structure

```
plugins/second-opinion/
├── .claude-plugin/plugin.json
├── .mcp.json
├── CLAUDE.md
├── AGENTS.md
├── README.md
├── agents/
│   └── opinion-presenter.md
├── docs/
│   └── schemas/
│       └── second-opinion.schema.json
├── hooks/
│   ├── hooks.json
│   └── stuck-detector.js
├── scripts/
│   └── validate-opinion.js
└── skills/
    └── second-opinion/SKILL.md
```

## Key Navigation Points

| Task | Primary File | Section |
|------|-------------|---------|
| Modify stuck detection thresholds | hooks/stuck-detector.js | Constants (REPEAT_THRESHOLD, COOLDOWN_MS) |
| Change Codex prompt | skills/second-opinion/SKILL.md | Step 3a |
| Adjust output schema | docs/schemas/second-opinion.schema.json | - |
| Modify output validation | scripts/validate-opinion.js | validateOutput() |
| Change Opus fallback behavior | agents/opinion-presenter.md | Workflow sections |
| Update presentation format | skills/second-opinion/SKILL.md | Step 4 |
| Change context gathering | skills/second-opinion/SKILL.md | Steps 1-2 |
| Adjust error patterns | hooks/stuck-detector.js | extractErrorSignature() |

## Integration Points

- **Codex MCP**: .mcp.json registers Codex as MCP server. Skill calls mcp__codex__codex for opinions
- **Opus fallback**: agents/opinion-presenter.md used when Codex MCP unavailable or returns non-JSON
- **PostToolUse hook**: hooks/stuck-detector.js monitors for repeated errors
- **No temp files**: Stuck-detector state in os.tmpdir()
