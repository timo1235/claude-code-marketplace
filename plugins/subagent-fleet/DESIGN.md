# subagent-fleet — Design & Plan

> Status: Überarbeiteter Entwurf. Beschreibt **was** gebaut wird und **warum**. Implementierung folgt.

## Problem / Idee

Ein Frontier-Model (Fable 5, Opus, GPT-5, …) ist als **Orchestrator + Reviewer** stark,
aber teuer. Mechanische und klar umrissene Ausführung (Coding zu Spec, Recherche,
Massen-Edits) muss nicht auf dem teuersten Model laufen. Ziel:

> Der Orchestrator plant, zerlegt, **delegiert Ausführung an günstigere Fremdprovider-Worker
> (GLM/z.ai, DeepSeek, OpenRouter, …)** und **reviewt** deren Ergebnis. Welche Provider und
> Modelle die Worker nutzen, ist reine **Konfiguration** — Credentials hinterlegen, Modelle
> definieren, fertig.

Nicht an eine `.zshrc` gebunden, nicht an Fable gebunden, nicht an Anthropic-Abo gebunden.
Andere Nutzer sollen es installieren, Keys eintragen und loslegen können.

## Kern-Constraint (warum ein Dispatch-Script nötig ist)

Das eingebaute **Task-Tool erbt `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` vom
Elternprozess**. Eine laufende Session hat **genau ein Backend**; der einzige
Per-Subagent-Knopf ist der *Modellname*, den dieses eine Backend bedient. Damit lässt sich
**kein** Subagent auf z.ai schicken, während der Orchestrator auf Anthropic läuft.

→ Mechanismus: Der Orchestrator ruft pro delegierter Aufgabe via **Bash** ein separates
**`claude -p` (headless)** auf, mit provider-spezifischen Env-Variablen. Jeder Worker ist
eine eigene Claude-Code-Instanz, gegen den Fremdprovider authentifiziert; die Anthropic-Auth
wird im Worker-Prozess entfernt. Ergebnis (inkl. Token-Usage und `session_id`) kommt als
JSON zurück, der Orchestrator reviewt. (Gleiches Grundprinzip wie `ethanhq/cc-fleet`.)

Verifiziert: `claude -p "…" --output-format json --model … --allowedTools … --permission-mode
… --append-system-prompt …` existiert und liefert `{ result, session_id, total_cost_usd,
usage, num_turns, … }`. Ebenfalls verifiziert vorhanden: `--resume <session-id>`,
`--setting-sources`, `--strict-mcp-config`.

## Worker-Isolation (wichtig)

Ein gespawnter `claude -p` lädt standardmäßig die **komplette User-/Projekt-Konfiguration**:
`~/.claude/settings.json`, Projekt-Settings, alle Plugins, Hooks und MCP-Server. Folgen:
Hooks des Users feuern im Worker, MCP-Server starten pro Worker neu (Latenz), und das
fleet-Skill würde sich selbst in jeden Worker laden.

Deshalb startet `fleet.mjs` Worker **standardmäßig isoliert**:

- `--setting-sources ""` (keine User-/Projekt-Settings, keine Plugins/Hooks) — per Config
  überschreibbar (`settingSources`), falls jemand Projekt-Settings im Worker braucht.
- `--strict-mcp-config` (keine MCP-Server, außer explizit via Config gewünscht).
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` im Worker-Env (kein Update-Check/Telemetrie).
- Anthropic-Auth entfernt: `ANTHROPIC_API_KEY`, OAuth-Token u.ä. werden aus dem Env gelöscht,
  damit kein Abo/kein falscher Key durchschlägt.

## Provider-Kompatibilität

Der Env-Weg funktioniert nur mit **Anthropic-Messages-kompatiblen** Endpoints:

| Provider   | Base URL                          | Kompatibel |
|------------|-----------------------------------|------------|
| DeepSeek   | `https://api.deepseek.com/anthropic` | ✓ |
| z.ai / GLM | `https://api.z.ai/api/anthropic`     | ✓ |
| OpenRouter | `https://openrouter.ai/api`          | ✓ („Anthropic Skin", inkl. Tool-Use/Thinking) |

Base-URLs werden nicht blind der Doku geglaubt: **`fleet.mjs doctor --ping`** macht pro
Provider einen minimalen Ein-Turn-Call und verifiziert die ganze Kette (URL, Auth,
Modellname) für Centbeträge.

Claude Code macht intern zusätzliche Calls mit einem Haiku-Klasse-Modell (Zusammenfassungen
u.ä.). Auf einem Fremd-Backend schlägt das mit dem Default-Claude-Modellnamen fehl — deshalb
hat jeder Provider ein **`smallFastModel`**, das als `ANTHROPIC_SMALL_FAST_MODEL` (bzw.
`ANTHROPIC_DEFAULT_HAIKU_MODEL`) ins Worker-Env gesetzt wird.

Reine OpenAI-Format-Provider brauchen einen Shim (claude-code-router / LiteLLM) — bewusst
nicht Teil von v1.

## Komponenten

```
plugins/subagent-fleet/
  .claude-plugin/plugin.json
  scripts/fleet.mjs              # Dispatch-CLI (Node, keine Dependencies)
  fleet.config.example.json      # Vorlage: Provider + Rollen (ohne Secrets)
  skills/fleet/SKILL.md          # Orchestrierungs-Policy (provider-agnostisch)
  README.md
  DESIGN.md                      # dieses Dokument
```

### 1. Konfiguration (`fleet.config.json`)

Secrets stehen **nie** in der Config — nur der **Name** der Env-Variable. Suchreihenfolge:
`$FLEET_CONFIG` → `$CLAUDE_PROJECT_DIR/.claude/fleet.config.json` →
`./.claude/fleet.config.json` → `$CLAUDE_CONFIG_DIR/fleet.config.json` →
`~/.claude/fleet.config.json`.

```jsonc
{
  // optional: dotenv-Datei, aus der Keys geladen werden (generisch, kein fester Pfad)
  "envFile": "~/.config/fleet/.env",
  "providers": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com/anthropic",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "smallFastModel": "deepseek-v4-flash",
      "models": { "strong": "deepseek-v4-pro", "default": "deepseek-v4-flash", "fast": "deepseek-v4-flash" },
      // optional: Preise pro 1M Token → fleet.mjs rechnet Kosten selbst (USD)
      "pricing": { "deepseek-v4-pro": { "input": 0.6, "output": 2.4 } }
    },
    "zai": {
      "baseUrl": "https://api.z.ai/api/anthropic",
      "apiKeyEnv": "ZAI_API_KEY",
      "smallFastModel": "glm-5.2-air",
      "models": { "strong": "glm-5.2", "default": "glm-5.2", "fast": "glm-5.2-air" }
    },
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "smallFastModel": "z-ai/glm-4.6",
      "models": { "strong": "deepseek/deepseek-v4", "default": "z-ai/glm-4.6", "fast": "z-ai/glm-4.6" }
    }
  },
  "roles": {
    "coder":      { "provider": "zai",      "model": "strong", "tools": "Read,Edit,Write,Grep,Glob,Bash" },
    "researcher": { "provider": "deepseek", "model": "fast",   "tools": "Read,Grep,Glob,WebFetch" },
    "grunt":      { "provider": "deepseek", "model": "fast",   "tools": "Read,Edit,Write,Grep,Glob" }
  },
  "defaults": { "permissionMode": "acceptEdits", "maxTurns": 40, "timeoutSec": 1800 }
}
```

Hinweis Modellnamen: Werte sind Beispiele; die realen Namen prüft `doctor --ping`.
(Kein `[1m]`-Suffix — das ist eine Anthropic-/Claude-Code-Konvention, kein Fremdprovider-Name.)

### 2. Dispatch-CLI (`scripts/fleet.mjs`)

Node, ohne externe Dependencies. Kommandos:

- `fleet.mjs doctor [--ping]` — listet Provider + Key-Status; mit `--ping` ein minimaler
  Live-Call pro Provider (verifiziert URL/Auth/Modellname).
- `fleet.mjs list` — zeigt konfigurierte Rollen/Provider/Modelle.
- `fleet.mjs run --role <role> --task "<text>" [--cwd <dir>] [--format json|text]`
  - Alt.: `--provider <id> --model <tier|literal>`; `--task-file <path>` oder stdin.
  - baut Worker-Env: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`,
    `ANTHROPIC_SMALL_FAST_MODEL`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`;
    **entfernt** `ANTHROPIC_API_KEY`/OAuth-Token. Das Modell kommt über `--model` (nicht
    zusätzlich per Env — Redundanz vermeiden).
  - exec `claude -p <task> --output-format json --model … --allowedTools …
    --permission-mode … --max-turns … --setting-sources "" --strict-mcp-config
    --append-system-prompt <worker-preamble>` im gewählten `cwd`;
  - **Hard-Timeout** (`timeoutSec`, Default 30 min): Worker wird gekillt, Fehler-JSON zurück.
  - Output an den Orchestrator: `result`, `session_id`, `usage` (Token), berechnete Kosten
    (aus `pricing`, falls konfiguriert — `total_cost_usd` der CLI ist für Fremdmodelle
    unzuverlässig, da mit Anthropic-Preisen gerechnet), Exit-Code != 0 bei Fehler.
- `fleet.mjs run --resume <session-id> --task "<follow-up>"` — **Review-Loop**: setzt die
  Worker-Session mit vollem Kontext fort (gleiches Env-Setup wie beim Erst-Dispatch).
  Fällt ein Review durch, kostet die Korrektur so nur das Delta statt eines neuen Workers.

**Worker-Preamble** (append-system-prompt): „Du bist ein delegierter Worker. Tu genau die
Aufgabe, keine Scope-Erweiterung. Du kannst nicht rückfragen — bei echter Entscheidung: nennen
und stoppen. Antworte knapp: was getan, was geändert (Dateien), was verifiziert, was offen.
Deine Edits werden vom Orchestrator reviewt."

### 3. Skill (`skills/fleet/SKILL.md`)

Provider-agnostische Orchestrierungs-Policy. Trigger: „fleet", „delegate", „subagent",
„glm/deepseek/openrouter", „günstigeres Model". Inhalt:

- Rolle des Orchestrators: verstehen, planen, **zerlegen**, delegieren, **reviewen**, integrieren.
- Delegieren = `node $CLAUDE_PLUGIN_ROOT/scripts/fleet.mjs run --role … --task "…" --cwd .`.
- **Nicht-triviale Dispatches via `run_in_background`** starten (das Bash-Tool des
  Orchestrators hat max. 10 min Timeout; Worker dürfen länger laufen).
- Vollständige, self-contained Assignments (Worker kann nicht rückfragen).
- **Review ist Pflicht**: Code → `git diff`, Recherche → Output prüfen. Der Orchestrator
  besitzt das Endergebnis. Fällt ein Review durch → `--resume <session-id>` mit präzisem
  Fix-Auftrag statt neuem Worker.
- **Parallelität**: parallele Worker nur auf **disjunkten Dateien**; sonst sequenziell oder
  per Git-Worktree (`--cwd` auf ein Worktree zeigen).
- Websuche macht der Orchestrator (WebSearch ist ein serverseitiges Anthropic-Tool, auf
  Fremd-Backends nicht verfügbar); Worker bekommen konkrete URLs für `WebFetch`.
- Kostenbewusstsein: JSON-Output enthält Token-Usage + ggf. berechnete Kosten.
- Wann **nicht** delegieren: Triviales, enge Iteration mit User, reine Entscheidungen.

## Sicherheit

- Keine Secrets im Repo/Config — nur Env-Var-Namen; Keys aus Env oder optionaler `envFile`.
- `ANTHROPIC_BASE_URL` niemals global setzen — nur inline im Worker-Subprozess.
- Worker laufen in definiertem `cwd`; Edits sind über `git diff` reviewbar.
- **`--allowedTools` ist eine Permission-Allowlist**: Was dort steht, läuft ohne Nachfrage.
  Eine Rolle mit `Bash` hat damit faktisch **vollen Shell-Zugriff** im `cwd`, unabhängig vom
  `permissionMode`. Konsequenz: `Bash` nur Rollen geben, die es brauchen (im Beispiel hat
  `grunt` bewusst kein Bash); README weist explizit darauf hin.
- `permissionMode` konfigurierbar; `bypassPermissions` nur bewusst als Opt-in.

## Test / Definition of Done

1. `fleet.mjs doctor` zeigt die Provider + Key-Status; `doctor --ping` verifiziert mindestens
   einen Provider live.
2. Echter Dispatch mit **günstigstem Modell**: trivialer Coding-Task in einem
   Temp-Verzeichnis, Worker legt Datei an → JSON mit `result`, `session_id`, Usage;
   Datei existiert. Beweis, dass es real funktioniert.
3. **Resume-Test**: Follow-up via `--resume` auf dieselbe Worker-Session, Worker hat den
   Kontext des Erst-Auftrags.
4. Nachweis, dass die Orchestrator-Session (Anthropic) unberührt bleibt (kein Anthropic-Auth
   im Worker-Env; Worker-Task gibt relevante `ANTHROPIC_*`-Var-Namen aus, keine Werte).
5. Timeout-Test: `timeoutSec` klein setzen → Worker wird gekillt, sauberes Fehler-JSON.

## Bezug zum alten `fable-orchestrator`

Das bisherige Plugin delegierte nur **innerhalb Anthropic** (haiku/sonnet/opus, Abo-nativ) und
war Fable-gebrandet. `subagent-fleet` verallgemeinert: beliebiger Orchestrator, Fremdprovider
per Config. Der alte Plugin-Ordner wandert ins `archive/`; `marketplace.json` wird
entsprechend aktualisiert.
