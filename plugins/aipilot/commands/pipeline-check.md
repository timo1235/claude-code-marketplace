---
description: Verify aipilot pipeline setup (scripts, agents, schemas, CLI tools)
allowed-tools:
  - Bash
---

Run the pipeline dry-run check to verify all components are properly set up:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.sh" dry-run --plugin-root "${CLAUDE_PLUGIN_ROOT}" --project-dir "${CLAUDE_PROJECT_DIR}"
```

Parse the output and present results to the user:

- If the output ends with `Dry run PASSED`, report: **Pipeline ready. All checks passed.**
- If the output ends with `Dry run FAILED`, list each FAIL and WARN line with remediation advice:
  - FAIL node: "Install Node.js"
  - WARN codex: "Install Codex CLI for MCP server. Required for AI-powered reviews."
  - WARN/FAIL .mcp.json: "MCP configuration missing. The plugin requires .mcp.json for Codex integration."
  - WARN schema: "Schema file missing at <path>. Pipeline may produce unstructured review output."

Format the output as a checklist using checkmark/cross symbols:
- Use a checkmark for OK items
- Use a warning symbol for WARN items
- Use a cross for FAIL items
