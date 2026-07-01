# Claude Code Marketplace

A collection of plugins for [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

## Installation

Inside a Claude Code session:

```
/plugin marketplace add timo1235/claude-code-marketplace
```

Or from the terminal:

```bash
claude plugin marketplace add timo1235/claude-code-marketplace
```

Then browse and install plugins with `/plugin`.

## Available Plugins

| Plugin | Category | Description | Details |
|--------|----------|-------------|---------|
| [subagent-fleet](plugins/subagent-fleet) | Productivity | Orchestrator on the frontier model, execution on cheap third-party workers (z.ai/GLM, DeepSeek, OpenRouter): delegates tasks to headless `claude -p` workers via config and reviews their results. | [README](plugins/subagent-fleet/README.md) |

## Plugin Structure

```
.claude-plugin/
  marketplace.json          # marketplace registry
plugins/
  <plugin-name>/
    .claude-plugin/
      plugin.json           # plugin manifest
    skills/                 # skills (optional)
    agents/                 # agents (optional)
    hooks/                  # hooks (optional)
```

## License

MIT
