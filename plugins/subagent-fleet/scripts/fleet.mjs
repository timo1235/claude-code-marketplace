#!/usr/bin/env node
// fleet.mjs — Dispatch-CLI for the subagent-fleet plugin.
// No external dependencies (node: builtins only). See DESIGN.md for the spec.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import process from 'node:process';

const WORKER_PREAMBLE =
  'You are a delegated worker. Do exactly the assigned task, no scope expansion. ' +
  'You cannot ask questions — if a real decision is needed, state it and stop. ' +
  'Answer concisely: what was done, which files changed, what was verified, what remains open. ' +
  'Your edits will be reviewed by the orchestrator.';

// Context discipline. Worker runs that re-read large files in full burn through
// provider quotas (observed: 8M cache-read tokens for one work package) and are
// the runs most likely to die mid-way, so keep reads bounded and never repeated.
const WORKER_READ_RULES =
  'Keep your context small: never read a file larger than ~30 KB in one call — use ' +
  'offset/limit or Grep for the part you need. Do not re-read a file you already have in ' +
  'context unless you edited it since. Write each deliverable to disk as soon as it is ' +
  'designed instead of accumulating everything for the end.';

// Checkpointing. With a progress file, a resumed run (after a dropped stream, a
// quota hit or a timeout) knows what is already done instead of guessing.
function progressRules(progressFile) {
  if (!progressFile) return '';
  return (
    ` Progress file: ${progressFile}. Before you start, read it if it exists and skip every ` +
    'deliverable it lists as done. After you finish each deliverable (a file written, a test ' +
    'passing, an integration edit made), append one line "- done: <what>" to it — create the ' +
    'file if missing. Never rewrite or delete existing lines.'
  );
}

function buildPreamble(progressFile) {
  return WORKER_PREAMBLE + ' ' + WORKER_READ_RULES + progressRules(progressFile);
}

// Prompt for an automatic continuation of an interrupted session.
function continuationPrompt(reason, progressFile) {
  let text =
    `Your previous turn was interrupted (${reason}); nothing you wrote to disk was lost. ` +
    'Continue exactly where you stopped with the same task and rules. Do not redo finished ' +
    'work and do not re-read files you already read unless you need to edit them.';
  if (progressFile) {
    text += ` Read the progress file ${progressFile} first to see what is already done.`;
  }
  text += ' End with the report the task asks for.';
  return text;
}

const AUTH_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  // A worker must talk to the configured baseUrl — Bedrock/Vertex routing would
  // silently override it, so strip those toggles as well.
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
];

const TIERS = ['strong', 'default', 'fast'];

// Worker runtimes. "claude" spawns a headless `claude -p` against an
// Anthropic-compatible baseUrl; "opencode" spawns `opencode run`, which brings
// its own provider auth (`opencode auth` / auth.json) and model catalog.
const RUNNERS = ['claude', 'opencode'];

function runnerOf(provider) {
  return provider.runner || 'claude';
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

class FleetError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function die(message, exitCode = 1) {
  process.stderr.write(String(message) + '\n');
  process.exit(exitCode);
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function truncate(str, max) {
  if (str == null) return str;
  str = String(str);
  return str.length > max ? str.slice(0, max) + '…[truncated]' : str;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function findConfigPath() {
  const candidates = [];
  if (process.env.FLEET_CONFIG) candidates.push(process.env.FLEET_CONFIG);
  if (process.env.CLAUDE_PROJECT_DIR) {
    candidates.push(path.join(process.env.CLAUDE_PROJECT_DIR, '.claude', 'fleet.config.json'));
  }
  candidates.push(path.join(process.cwd(), '.claude', 'fleet.config.json'));
  if (process.env.CLAUDE_CONFIG_DIR) {
    candidates.push(path.join(process.env.CLAUDE_CONFIG_DIR, 'fleet.config.json'));
  }
  candidates.push(path.join(os.homedir(), '.claude', 'fleet.config.json'));

  for (const c of candidates) {
    const resolved = expandHome(c);
    if (resolved && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return resolved;
    }
  }
  return null;
}

function loadConfig() {
  const configPath = findConfigPath();
  if (!configPath) {
    throw new FleetError(
      'No fleet config found. Searched: $FLEET_CONFIG, ' +
        '$CLAUDE_PROJECT_DIR/.claude/fleet.config.json, ./.claude/fleet.config.json, ' +
        '$CLAUDE_CONFIG_DIR/fleet.config.json, ~/.claude/fleet.config.json.\n' +
        'Copy fleet.config.example.json to one of these locations and fill it in.',
      2,
    );
  }

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    throw new FleetError(`Cannot read config ${configPath}: ${err.message}`, 2);
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    throw new FleetError(`Config ${configPath} is not valid JSON: ${err.message}`, 2);
  }

  validateConfig(config, configPath);

  // Parse optional envFile into a separate map (never touches process.env).
  const envFileValues = loadEnvFile(config.envFile);

  return { config, configPath, envFileValues };
}

function validateConfig(config, configPath) {
  if (!config || typeof config !== 'object') {
    throw new FleetError(`Config ${configPath} must be a JSON object.`, 2);
  }
  const providers = config.providers;
  if (!providers || typeof providers !== 'object' || Object.keys(providers).length === 0) {
    throw new FleetError(`Config ${configPath}: "providers" must be a non-empty object.`, 2);
  }
  for (const [id, p] of Object.entries(providers)) {
    if (!p || typeof p !== 'object') {
      throw new FleetError(`Config ${configPath}: provider "${id}" must be an object.`, 2);
    }
    const runner = runnerOf(p);
    if (!RUNNERS.includes(runner)) {
      throw new FleetError(
        `Config ${configPath}: provider "${id}" has unknown runner "${runner}" ` +
          `(supported: ${RUNNERS.join(', ')}).`,
        2,
      );
    }
    // The claude runner talks to an Anthropic-compatible endpoint itself and
    // needs URL + key. The opencode runner authenticates via `opencode auth`.
    if (runner === 'claude') {
      if (!p.baseUrl) {
        throw new FleetError(`Config ${configPath}: provider "${id}" is missing "baseUrl".`, 2);
      }
      if (!p.apiKeyEnv) {
        throw new FleetError(`Config ${configPath}: provider "${id}" is missing "apiKeyEnv".`, 2);
      }
    }
    if (!p.models || typeof p.models !== 'object') {
      throw new FleetError(`Config ${configPath}: provider "${id}" is missing "models".`, 2);
    }
    // A quota fallback continues the *same session* on another provider, which only
    // works within one runner (the claude runner's transcript is local; opencode's
    // sessions live in its own db).
    if (p.fallback !== undefined) {
      const fb = providers[p.fallback];
      if (!fb) {
        throw new FleetError(
          `Config ${configPath}: provider "${id}" has unknown fallback "${p.fallback}".`,
          2,
        );
      }
      if (p.fallback === id) {
        throw new FleetError(`Config ${configPath}: provider "${id}" cannot be its own fallback.`, 2);
      }
      if (runnerOf(fb) !== runner) {
        throw new FleetError(
          `Config ${configPath}: provider "${id}" (runner ${runner}) has fallback "${p.fallback}" ` +
            `on runner ${runnerOf(fb)}; a fallback must use the same runner.`,
          2,
        );
      }
    }
    if (p.rateLimitTz !== undefined && !/^[+-]\d{2}:\d{2}$/.test(String(p.rateLimitTz))) {
      throw new FleetError(
        `Config ${configPath}: provider "${id}" has invalid rateLimitTz "${p.rateLimitTz}" ` +
          `(expected "+HH:MM" or "-HH:MM").`,
        2,
      );
    }
  }

  const roles = config.roles || {};
  for (const [name, r] of Object.entries(roles)) {
    if (!r || typeof r !== 'object') {
      throw new FleetError(`Config ${configPath}: role "${name}" must be an object.`, 2);
    }
    if (!providers[r.provider]) {
      throw new FleetError(
        `Config ${configPath}: role "${name}" references unknown provider "${r.provider}".`,
        2,
      );
    }
    // A role's model may be a tier (strong/default/fast) or a literal model name.
    // If it looks like a tier keyword, the provider must define it. Literals pass through.
    if (r.model && TIERS.includes(r.model)) {
      const models = providers[r.provider].models || {};
      if (!models[r.model]) {
        throw new FleetError(
          `Config ${configPath}: role "${name}" uses tier "${r.model}" but provider ` +
            `"${r.provider}" does not define it.`,
          2,
        );
      }
    }
  }
}

function loadEnvFile(envFilePath) {
  const map = new Map();
  if (!envFilePath) return map;
  const resolved = expandHome(envFilePath);
  if (!fs.existsSync(resolved)) {
    process.stderr.write(`Warning: envFile "${resolved}" not found; continuing without it.\n`);
    return map;
  }
  let raw;
  try {
    raw = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    process.stderr.write(`Warning: cannot read envFile "${resolved}": ${err.message}\n`);
    return map;
  }
  for (let line of raw.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip surrounding matching quotes.
    if (
      val.length >= 2 &&
      ((val[0] === '"' && val[val.length - 1] === '"') ||
        (val[0] === "'" && val[val.length - 1] === "'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) map.set(key, val);
  }
  return map;
}

// Look up a secret by env-var name: process.env wins, then envFile map.
function lookupKey(envVarName, envFileValues) {
  if (Object.prototype.hasOwnProperty.call(process.env, envVarName) && process.env[envVarName]) {
    return process.env[envVarName];
  }
  if (envFileValues.has(envVarName) && envFileValues.get(envVarName)) {
    return envFileValues.get(envVarName);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

// Resolve a model spec against a provider. A spec is either a tier keyword
// (strong/default/fast → provider.models[tier]) or a literal model name.
function resolveModel(provider, spec) {
  if (!spec) {
    return provider.models?.default || provider.models?.fast || provider.models?.strong;
  }
  if (TIERS.includes(spec)) {
    return provider.models?.[spec];
  }
  return spec; // literal
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true; // boolean flag
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

async function cmdDoctor(argv) {
  const { flags } = parseFlags(argv);
  const { config, configPath, envFileValues } = loadConfig();

  process.stdout.write(`Config: ${configPath}\n`);
  if (config.envFile) process.stdout.write(`envFile: ${expandHome(config.envFile)}\n`);
  process.stdout.write('\nProviders:\n');

  for (const [id, p] of Object.entries(config.providers)) {
    process.stdout.write(`  ${id}\n`);
    if (runnerOf(p) === 'opencode') {
      process.stdout.write(`    runner:         opencode (auth via \`opencode auth\`)\n`);
    } else {
      const keySet = lookupKey(p.apiKeyEnv, envFileValues) ? '✓' : '✗';
      process.stdout.write(`    baseUrl:        ${p.baseUrl}\n`);
      process.stdout.write(`    apiKeyEnv:      ${p.apiKeyEnv} [${keySet}]\n`);
      process.stdout.write(`    smallFastModel: ${p.smallFastModel || '(none)'}\n`);
    }
    const models = Object.entries(p.models || {})
      .map(([t, m]) => `${t}=${m}`)
      .join(', ');
    process.stdout.write(`    models:         ${models}\n`);
  }

  process.stdout.write('\nRoles:\n');
  for (const [name, r] of Object.entries(config.roles || {})) {
    const provider = config.providers[r.provider];
    const model = resolveModel(provider, r.model);
    process.stdout.write(
      `  ${name}: provider=${r.provider} model=${model || '(unresolved)'} ` +
        `tools=${r.tools || '(default)'}\n`,
    );
  }

  const runnersInUse = new Set(Object.values(config.providers).map((p) => runnerOf(p)));
  for (const runner of RUNNERS) {
    if (!runnersInUse.has(runner)) continue;
    process.stdout.write(`\n${runner} CLI:\n`);
    const version = await getCliVersion(runner);
    if (version.ok) {
      process.stdout.write(`  found: ${version.version}\n`);
    } else {
      process.stdout.write(`  NOT found in PATH (${version.error})\n`);
    }
  }

  if (flags.ping) {
    process.stdout.write('\nLive ping (fast-tier model, 1 turn):\n');
    let anyFailed = false;
    for (const [id, p] of Object.entries(config.providers)) {
      const runner = runnerOf(p);
      let key = null;
      if (runner === 'claude') {
        key = lookupKey(p.apiKeyEnv, envFileValues);
        if (!key) {
          process.stdout.write(`  ${id}: skipped (no key set)\n`);
          continue;
        }
      }
      const model = resolveModel(p, 'fast') || resolveModel(p, undefined);
      if (!model) {
        anyFailed = true;
        process.stdout.write(`  ${id}: FAILED — no model defined in "models".\n`);
        continue;
      }
      const stateDir = resolveWorkerStateDir(config);
      const res =
        runner === 'opencode'
          ? await pingOpencode(model, stateDir)
          : await pingProvider(p, key, model, stateDir);
      if (res.ok) {
        process.stdout.write(`  ${id}: OK (${model})\n`);
      } else {
        anyFailed = true;
        process.stdout.write(`  ${id}: FAILED (${model}) — ${truncate(res.error, 300)}\n`);
      }
    }
    if (anyFailed) process.exit(1);
  }
}

function getCliVersion(cmd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true, version: out.trim() });
      else resolve({ ok: false, error: (err || out).trim() || `exit ${code}` });
    });
  });
}

function pingProvider(provider, key, model, stateDir) {
  return new Promise((resolve) => {
    const env = buildWorkerEnv(provider, key, stateDir);
    const args = [
      '-p',
      'Reply with exactly: OK',
      '--output-format',
      'json',
      '--model',
      model,
      '--max-turns',
      '1',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--allowedTools',
      '',
    ];
    const child = spawn('claude', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish({ ok: false, error: 'timeout after 60s' });
    }, 60000);

    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => finish({ ok: false, error: e.message }));
    child.on('close', (code) => {
      if (code === 0) {
        // Optionally surface an is_error from the JSON.
        try {
          const j = JSON.parse(out);
          if (j.is_error) {
            finish({ ok: false, error: j.error || j.result || 'is_error' });
            return;
          }
        } catch {}
        finish({ ok: true });
      } else {
        let msg = err.trim();
        try {
          const j = JSON.parse(out);
          msg = j.error || j.result || msg;
        } catch {}
        finish({ ok: false, error: msg || `exit ${code}` });
      }
    });
  });
}

function pingOpencode(model, stateDir) {
  return new Promise((resolve) => {
    const args = ['run', '--model', model, '--format', 'json', '--pure', 'Reply with exactly: OK'];
    const env = applyWorkerStateDir({ ...process.env }, stateDir, 'opencode');
    const child = spawn('opencode', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish({ ok: false, error: 'timeout after 60s' });
    }, 60000);

    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => finish({ ok: false, error: e.message }));
    child.on('close', (code) => {
      const parsed = parseOpencodeOutput(out);
      if (code === 0 && parsed.errors.length === 0 && parsed.parsedAny) {
        finish({ ok: true });
      } else {
        finish({ ok: false, error: parsed.errors.join('; ') || err.trim() || `exit ${code}` });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function cmdList() {
  const { config } = loadConfig();
  const rows = [];
  for (const [name, r] of Object.entries(config.roles || {})) {
    const provider = config.providers[r.provider];
    const model = resolveModel(provider, r.model) || '(unresolved)';
    rows.push({
      role: name,
      provider: r.provider,
      runner: runnerOf(provider),
      model,
      tools: r.tools || '(default)',
      permissionMode: r.permissionMode || config.defaults?.permissionMode || '(default)',
    });
  }

  const cols = ['role', 'provider', 'runner', 'model', 'tools', 'permissionMode'];
  const widths = {};
  for (const c of cols) {
    widths[c] = c.length;
    for (const row of rows) widths[c] = Math.max(widths[c], String(row[c]).length);
  }
  const fmt = (row) => cols.map((c) => String(row[c]).padEnd(widths[c])).join('  ');
  const header = {};
  for (const c of cols) header[c] = c;
  process.stdout.write(fmt(header) + '\n');
  process.stdout.write(cols.map((c) => '-'.repeat(widths[c])).join('  ') + '\n');
  for (const row of rows) process.stdout.write(fmt(row) + '\n');
  if (rows.length === 0) process.stdout.write('(no roles configured)\n');
}

// ---------------------------------------------------------------------------
// Worker env
// ---------------------------------------------------------------------------

// Both runners persist a session per worker run, by default into the same store the
// orchestrator uses: `claude -p` writes $CLAUDE_CONFIG_DIR/projects/<slug>/<uuid>.jsonl,
// `opencode run` writes ~/.local/share/opencode/opencode.db. Anything that lists those
// as sessions — the /resume picker, session-browsing UIs like CloudCLI — then fills up
// with worker transcripts. Point the workers at a state dir of their own instead.
// Override the location with defaults.workerStateDir; set it to "" to opt out and let
// workers share the orchestrator's state.
const DEFAULT_WORKER_STATE_DIR = path.join(os.homedir(), '.local', 'state', 'subagent-fleet');

function resolveWorkerStateDir(config) {
  const configured = config?.defaults?.workerStateDir;
  if (configured === '') return null;
  if (!configured) return DEFAULT_WORKER_STATE_DIR;
  const raw = String(configured);
  const expanded = raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw;
  return path.resolve(expanded);
}

// Redirect worker session storage. An explicitly inherited CLAUDE_CONFIG_DIR /
// OPENCODE_DB always wins, so a caller can still override per invocation.
function applyWorkerStateDir(env, stateDir, runner) {
  if (!stateDir) return env;
  if (runner === 'opencode') {
    // opencode's auth.json stays in the shared data dir — OPENCODE_DB only moves
    // session storage, so provider auth is unaffected.
    if (!env.OPENCODE_DB) {
      const db = path.join(stateDir, 'opencode', 'fleet.db');
      fs.mkdirSync(path.dirname(db), { recursive: true });
      env.OPENCODE_DB = db;
    }
  } else if (!env.CLAUDE_CONFIG_DIR) {
    // Workers run with --setting-sources '' and env-supplied auth, so they need
    // nothing out of the orchestrator's config dir.
    env.CLAUDE_CONFIG_DIR = path.join(stateDir, 'claude');
  }
  return env;
}

function buildWorkerEnv(provider, key, stateDir) {
  const env = { ...process.env };
  for (const v of AUTH_ENV_VARS) delete env[v];
  env.ANTHROPIC_BASE_URL = provider.baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = key;
  if (provider.smallFastModel) {
    env.ANTHROPIC_SMALL_FAST_MODEL = provider.smallFastModel;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = provider.smallFastModel;
  }
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  return applyWorkerStateDir(env, stateDir, 'claude');
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

function readTask(flags) {
  const stdinAvailable = !process.stdin.isTTY && flags.task === undefined && flags['task-file'] === undefined;

  if (flags.task !== undefined && typeof flags.task !== 'string') {
    throw new FleetError('--task requires a value.', 2);
  }
  if (flags.task !== undefined && flags['task-file'] !== undefined) {
    throw new FleetError('Provide only one task source: --task or --task-file (or stdin).', 2);
  }

  if (flags.task !== undefined) return String(flags.task);
  if (flags['task-file'] !== undefined) {
    const fp = expandHome(String(flags['task-file']));
    if (!fs.existsSync(fp)) throw new FleetError(`--task-file not found: ${fp}`, 2);
    return fs.readFileSync(fp, 'utf8');
  }
  if (stdinAvailable) {
    try {
      const data = fs.readFileSync(0, 'utf8');
      if (data.trim()) return data;
    } catch {}
  }
  throw new FleetError('No task provided. Use --task "<text>", --task-file <path>, or pipe via stdin.', 2);
}

function computeCost(provider, model, usage) {
  const pricing = provider.pricing?.[model];
  if (!pricing || typeof pricing.input !== 'number' || typeof pricing.output !== 'number') {
    return { cost_usd: null, cost_source: 'unavailable' };
  }
  // Assumption: cache-creation tokens are billed at the input rate, and cache-read
  // tokens are also counted at the input rate. Providers differ, but this is a
  // reasonable upper-bound estimate; the CLI's own figure is Anthropic-priced and
  // wrong for foreign models, so we prefer this config-based number.
  const input =
    (usage.input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.cache_read_input_tokens || 0);
  const output = usage.output_tokens || 0;
  const cost = (input / 1e6) * pricing.input + (output / 1e6) * pricing.output;
  return { cost_usd: Math.round(cost * 1e6) / 1e6, cost_source: 'config-pricing' };
}

// `opencode run --format json` emits NDJSON events: step_start, text (part.text),
// tool, step_finish (part.tokens/{input,output,reasoning,cache:{read,write}} and
// part.cost), error. One step_finish per assistant turn.
function parseOpencodeOutput(stdout) {
  const events = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {}
  }

  let sessionId = null;
  const texts = [];
  const errors = [];
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  let cost = 0;
  let hasCost = false;
  let steps = 0;

  for (const ev of events) {
    if (!sessionId && ev.sessionID) sessionId = ev.sessionID;
    const part = ev.part || {};
    if (ev.type === 'text' && typeof part.text === 'string') {
      texts.push(part.text);
    } else if (ev.type === 'step_finish') {
      steps++;
      const tok = part.tokens || {};
      usage.input_tokens += tok.input || 0;
      usage.output_tokens += tok.output || 0;
      usage.cache_read_input_tokens += tok.cache?.read || 0;
      usage.cache_creation_input_tokens += tok.cache?.write || 0;
      if (typeof part.cost === 'number') {
        cost += part.cost;
        hasCost = true;
      }
    } else if (ev.type === 'error' || part.error) {
      const e = ev.error || part.error || ev;
      errors.push(typeof e === 'string' ? e : JSON.stringify(e));
    }
  }

  // What the worker did last — the only clue when opencode exits 1 without an
  // error event.
  const lastEvents = events.slice(-8).map((ev) => {
    const part = ev.part || {};
    if (ev.type === 'tool') return `tool:${part.tool || part.name || '?'}`;
    if (ev.type === 'text') return `text:${truncate(String(part.text || '').trim(), 80)}`;
    return String(ev.type || '?');
  });

  return {
    parsedAny: events.length > 0,
    sessionId,
    text: texts.join('\n'),
    usage,
    cost: hasCost ? cost : null,
    steps,
    errors,
    lastEvents,
  };
}

function extractUsage(cliJson) {
  const u = (cliJson && cliJson.usage) || {};
  return {
    input_tokens: u.input_tokens || 0,
    output_tokens: u.output_tokens || 0,
    cache_read_input_tokens: u.cache_read_input_tokens || 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
  };
}

function addUsage(total, part) {
  for (const k of Object.keys(total)) total[k] += part?.[k] || 0;
  return total;
}

// `claude -p --output-format stream-json --verbose` emits NDJSON: a system/init event
// (carries the session_id from the very first line), assistant/user events per turn,
// and one final {"type":"result",...} object with the same shape the plain json output
// has. Reading the stream instead of the final object means a killed worker still
// reports its session_id — the one thing needed to resume it.
function parseClaudeStream(stdout) {
  let sessionId = null;
  let result = null;
  let lastAssistantText = null;
  let parsedAny = false;
  for (const line of String(stdout).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    parsedAny = true;
    if (!sessionId && ev.session_id) sessionId = ev.session_id;
    if (ev.type === 'result') result = ev;
    if (ev.type === 'assistant') {
      const texts = (ev.message?.content || [])
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text);
      if (texts.length) lastAssistantText = texts.join('\n');
    }
  }
  // Plain `--output-format json` (a single object) still parses as a result.
  if (!result && parsedAny) {
    try {
      const j = JSON.parse(String(stdout).trim());
      if (j && typeof j === 'object' && 'is_error' in j) {
        result = j;
        sessionId = sessionId || j.session_id || null;
      }
    } catch {}
  }
  return { parsedAny, sessionId, result, lastAssistantText };
}

// ---------------------------------------------------------------------------
// Failure classification + retry policy
// ---------------------------------------------------------------------------

// Classes the retry loop acts on:
//   rate_limit     — provider quota / 429; switch to the fallback provider or wait.
//   transient      — dropped stream, network hiccup, 5xx; resume the same session.
//   empty_response — the model returned nothing (observed as "No response requested.");
//                    resume the same session with a nudge.
//   max_turns      — the worker used up --max-turns; not retried (the budget was the point).
//   timeout        — hard timeoutSec hit; not retried, but session_id is reported.
//   error          — anything else; not retried.
const RETRIABLE_CLASSES = new Set(['rate_limit', 'transient', 'empty_response']);

function classifyFailure({ text, timedOut, subtype, apiErrorStatus, exitCode, ok }) {
  if (timedOut) return 'timeout';
  const t = String(text || '');
  if (ok && (!t.trim() || /^No response requested\.?$/i.test(t.trim()))) return 'empty_response';
  if (ok) return null;
  if (subtype === 'error_max_turns') return 'max_turns';
  if (
    apiErrorStatus === 429 ||
    /\b429\b|rate.?limit|usage limit|quota|too many requests|insufficient.?balance/i.test(t)
  ) {
    return 'rate_limit';
  }
  if (
    apiErrorStatus === 500 ||
    apiErrorStatus === 502 ||
    apiErrorStatus === 503 ||
    apiErrorStatus === 504 ||
    apiErrorStatus === 529 ||
    /stream closed|connection (error|reset|refused|closed)|ECONN|ETIMEDOUT|EPIPE|socket hang up|fetch failed|network|\b50[234]\b|\b529\b|overloaded|internal server error|terminated|aborted/i.test(
      t,
    )
  ) {
    return 'transient';
  }
  if (!t.trim() && exitCode !== 0) return 'transient';
  return 'error';
}

// Providers phrase reset times differently; two shapes are known:
//   z.ai:      "...Your limit will reset at 2026-09-17 06:46:37]..." (wall clock in the
//              provider's timezone — configure provider.rateLimitTz, e.g. "+08:00")
//   Anthropic: rate_limit_event with resetsAt (unix seconds) in the stream
// Returns { reset_at (ISO) , retry_after_sec } or nulls when nothing parseable is found.
function parseRateLimitReset(text, provider, now = Date.now()) {
  const m = String(text || '').match(/reset(?:s)? at (\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/i);
  if (!m) return { reset_at: null, retry_after_sec: null, reset_at_raw: null };
  const raw = `${m[1]} ${m[2]}`;
  const tz = provider?.rateLimitTz;
  if (!tz || !/^[+-]\d{2}:\d{2}$/.test(tz)) {
    // Without a timezone the wall clock is ambiguous — report it, don't compute.
    return { reset_at: null, retry_after_sec: null, reset_at_raw: raw };
  }
  const resetMs = Date.parse(`${m[1]}T${m[2]}${tz}`);
  if (Number.isNaN(resetMs)) return { reset_at: null, retry_after_sec: null, reset_at_raw: raw };
  return {
    reset_at: new Date(resetMs).toISOString(),
    retry_after_sec: Math.max(0, Math.ceil((resetMs - now) / 1000)),
    reset_at_raw: raw,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Per-provider concurrency slots
// ---------------------------------------------------------------------------

// Parallel workers on one provider key share one quota. Four glm-5.3 coders drained a
// full five-hour z.ai window in twenty minutes, killing two of them mid-file. Every
// `run` therefore takes a slot under <stateDir>/slots/<provider>/ and waits while the
// provider is at capacity. Slots are pid files; a dead pid is a stale slot.
function slotsDir(stateDir, providerId) {
  const base = stateDir || DEFAULT_WORKER_STATE_DIR;
  return path.join(base, 'slots', providerId.replace(/[^\w.-]/g, '_'));
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function liveSlots(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let live = 0;
  for (const name of names) {
    const pid = Number(name.replace(/\.lock$/, ''));
    if (Number.isInteger(pid) && pidAlive(pid)) live++;
    else {
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch {}
    }
  }
  return live;
}

async function acquireProviderSlot(stateDir, providerId, maxParallel) {
  if (!maxParallel || maxParallel <= 0) return null;
  const dir = slotsDir(stateDir, providerId);
  fs.mkdirSync(dir, { recursive: true });
  const mine = path.join(dir, `${process.pid}.lock`);
  let announced = false;
  for (;;) {
    if (liveSlots(dir) < maxParallel) {
      fs.writeFileSync(mine, String(Date.now()));
      const release = () => {
        try {
          fs.unlinkSync(mine);
        } catch {}
      };
      process.on('exit', release);
      return release;
    }
    if (!announced) {
      process.stderr.write(
        `fleet: provider "${providerId}" is at its parallel limit (${maxParallel}); waiting for a slot…\n`,
      );
      announced = true;
    }
    await sleep(5000);
  }
}

async function cmdRun(argv) {
  const { flags } = parseFlags(argv);
  const { config, envFileValues } = loadConfig();
  const defaults = config.defaults || {};

  // Resolve provider + role + model.
  let providerId;
  let role = null;
  let roleName = null;
  if (flags.role !== undefined) {
    roleName = String(flags.role);
    role = (config.roles || {})[roleName];
    if (!role) throw new FleetError(`Unknown role "${roleName}". See "fleet.mjs list".`, 2);
    providerId = role.provider;
  } else if (flags.provider !== undefined) {
    providerId = String(flags.provider);
  } else {
    throw new FleetError('Specify --role <name> or --provider <id>.', 2);
  }

  const provider = config.providers[providerId];
  if (!provider) throw new FleetError(`Unknown provider "${providerId}".`, 2);

  // Model: --model overrides; else role.model; else provider default.
  let modelSpec;
  if (flags.model !== undefined && typeof flags.model === 'string') modelSpec = flags.model;
  else if (role && role.model) modelSpec = role.model;
  const model = resolveModel(provider, modelSpec);
  if (!model) {
    throw new FleetError(
      `Could not resolve a model for provider "${providerId}" (spec: ${modelSpec || 'default'}).`,
      2,
    );
  }
  // The tier a fallback provider resolves the model with: the explicit/role tier if
  // there is one, otherwise "default" (a literal id is meaningless on another provider).
  const fallbackTier = TIERS.includes(modelSpec) ? modelSpec : 'default';

  const runner = runnerOf(provider);
  const workerStateDir = resolveWorkerStateDir(config);

  // Key — only the claude runner needs one; opencode authenticates itself.
  const keyFor = (pid, p) => {
    if (runnerOf(p) !== 'claude') return null;
    const k = lookupKey(p.apiKeyEnv, envFileValues);
    if (!k) {
      throw new FleetError(
        `API key not set for provider "${pid}". Set env var ${p.apiKeyEnv}, ` +
          `or add it to the configured envFile.`,
        2,
      );
    }
    return k;
  };
  const key = keyFor(providerId, provider);

  const task = readTask(flags);

  // Tools: --tools overrides role tools.
  let tools;
  if (flags.tools !== undefined) tools = flags.tools === true ? '' : String(flags.tools);
  else if (role && role.tools !== undefined) tools = role.tools;
  else tools = '';

  const permissionMode =
    (flags['permission-mode'] !== undefined && String(flags['permission-mode'])) ||
    role?.permissionMode ||
    defaults.permissionMode ||
    'acceptEdits';

  const maxTurns =
    (flags['max-turns'] !== undefined && Number(flags['max-turns'])) ||
    role?.maxTurns ||
    defaults.maxTurns ||
    40;

  const timeoutSec =
    (flags.timeout !== undefined && Number(flags.timeout)) || defaults.timeoutSec || 1800;

  const cwd = flags.cwd !== undefined ? expandHome(String(flags.cwd)) : process.cwd();
  if (!fs.existsSync(cwd)) throw new FleetError(`--cwd does not exist: ${cwd}`, 2);

  const format = flags.format !== undefined ? String(flags.format) : 'json';
  if (format !== 'json' && format !== 'text') {
    throw new FleetError(`--format must be "json" or "text".`, 2);
  }

  const settingSources = defaults.settingSources !== undefined ? String(defaults.settingSources) : '';

  const agentName =
    (flags.agent !== undefined && typeof flags.agent === 'string' && flags.agent) || role?.agent;

  // Progress file: explicit --progress-file, else derived from --task-file
  // (.fleet/w5.txt → .fleet/w5.progress.md). "" or "none" disables it.
  let progressFile = null;
  if (flags['progress-file'] !== undefined) {
    const v = flags['progress-file'];
    if (typeof v === 'string' && v !== '' && v !== 'none') progressFile = path.resolve(expandHome(v));
  } else if (flags['task-file'] !== undefined) {
    const tf = path.resolve(expandHome(String(flags['task-file'])));
    progressFile = tf.replace(/\.[^./\\]+$/, '') + '.progress.md';
  }

  // Retry policy.
  const maxRetries =
    flags.retries !== undefined ? Number(flags.retries) : Number(defaults.maxRetries ?? 3);
  const backoffSec = Number(defaults.retryBackoffSec ?? 15);
  const rateLimitWaitMaxSec = Number(defaults.rateLimitWaitMaxSec ?? 0);

  // Concurrency slot on the provider (0 = unlimited).
  const maxParallelFor = (p) =>
    flags['max-parallel'] !== undefined
      ? Number(flags['max-parallel'])
      : Number(p.maxParallel ?? defaults.maxParallelPerProvider ?? 2);

  let current = { providerId, provider, model, key, runner };
  let releaseSlot = await acquireProviderSlot(workerStateDir, providerId, maxParallelFor(provider));

  let sessionId =
    flags.resume !== undefined && typeof flags.resume === 'string' ? String(flags.resume) : null;
  let isResume = sessionId !== null;
  let prompt = task;

  const attempts = [];
  const totalUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  let totalCost = null;
  let costSource = 'unavailable';
  let totalCliCost = null;
  let totalTurns = 0;
  const started = Date.now();

  let final = null;
  for (let attempt = 1; ; attempt++) {
    const spec = buildWorkerCommand({
      ...current,
      prompt,
      isResume,
      sessionId,
      tools,
      permissionMode,
      maxTurns,
      settingSources,
      cwd,
      workerStateDir,
      agentName,
      progressFile,
    });
    const attemptStart = Date.now();
    const raw = await runWorker(spec.cmd, spec.args, spec.env, cwd, timeoutSec);
    const a = interpretAttempt(current.runner, raw, current.provider, current.model);
    a.duration_ms = Date.now() - attemptStart;

    if (a.sessionId) sessionId = a.sessionId;
    addUsage(totalUsage, a.usage);
    if (a.cost_usd != null) {
      totalCost = (totalCost || 0) + a.cost_usd;
      costSource = a.cost_source;
    }
    if (a.cli_cost != null) totalCliCost = (totalCliCost || 0) + a.cli_cost;
    if (a.num_turns) totalTurns += a.num_turns;

    attempts.push({
      attempt,
      provider: current.providerId,
      model: current.model,
      ok: a.ok && !a.error_class,
      error_class: a.error_class || null,
      error: a.error ? truncate(a.error, 300) : null,
      num_turns: a.num_turns,
      duration_ms: a.duration_ms,
      session_id: a.sessionId || sessionId,
    });

    if (a.ok && !a.error_class) {
      final = { ok: true, attempt: a };
      break;
    }

    const rateInfo =
      a.error_class === 'rate_limit' ? parseRateLimitReset(a.error, current.provider) : null;
    const retriable = RETRIABLE_CLASSES.has(a.error_class) && attempt <= maxRetries;
    if (!retriable) {
      final = { ok: false, attempt: a, rateInfo };
      break;
    }

    // Decide how to continue.
    let reason;
    if (a.error_class === 'rate_limit') {
      const fbId = current.provider.fallback;
      const fb = fbId ? config.providers[fbId] : null;
      const fbModel = fb ? resolveModel(fb, fallbackTier) : null;
      let fbKey = null;
      let fbUsable = Boolean(fb) && fbId !== current.providerId && runnerOf(fb) === current.runner && fbModel;
      if (fbUsable) {
        try {
          fbKey = keyFor(fbId, fb);
        } catch (e) {
          process.stderr.write(`fleet: fallback provider "${fbId}" unusable: ${e.message}\n`);
          fbUsable = false;
        }
      }
      if (fbUsable) {
        process.stderr.write(
          `fleet: attempt ${attempt} on "${current.providerId}" hit its quota; ` +
            `continuing session on fallback provider "${fbId}" (${fbModel}).\n`,
        );
        if (releaseSlot) releaseSlot();
        current = { providerId: fbId, provider: fb, model: fbModel, key: fbKey, runner: current.runner };
        releaseSlot = await acquireProviderSlot(workerStateDir, fbId, maxParallelFor(fb));
        reason = 'the provider quota was exhausted; you are now served by another provider';
      } else if (
        rateInfo.retry_after_sec != null &&
        rateInfo.retry_after_sec <= rateLimitWaitMaxSec
      ) {
        process.stderr.write(
          `fleet: quota exhausted on "${current.providerId}"; waiting ${rateInfo.retry_after_sec}s ` +
            `until ${rateInfo.reset_at} before resuming.\n`,
        );
        await sleep(rateInfo.retry_after_sec * 1000 + 5000);
        reason = 'the provider quota was exhausted and has now reset';
      } else {
        final = { ok: false, attempt: a, rateInfo };
        break;
      }
    } else {
      const waitSec = backoffSec * 2 ** (attempt - 1);
      process.stderr.write(
        `fleet: attempt ${attempt} failed (${a.error_class}: ${truncate(a.error, 120)}); ` +
          `retrying in ${waitSec}s${sessionId ? ` by resuming session ${sessionId}` : ''}.\n`,
      );
      await sleep(waitSec * 1000);
      reason =
        a.error_class === 'empty_response'
          ? 'your last turn produced no output'
          : 'a transport error cut the connection';
    }

    if (sessionId) {
      isResume = true;
      prompt = continuationPrompt(reason, progressFile);
    } else {
      isResume = false;
      prompt = task;
    }
  }

  if (releaseSlot) releaseSlot();

  const a = final.attempt;
  const out = {
    ok: final.ok,
    provider: current.providerId,
    model: current.model,
    role: roleName,
    session_id: sessionId,
    num_turns: totalTurns || null,
    duration_ms: Date.now() - started,
    usage: totalUsage,
    cost_usd: totalCost == null ? null : Math.round(totalCost * 1e6) / 1e6,
    cost_source: costSource,
    cli_reported_cost_usd: totalCliCost,
    result: a.text ?? null,
    attempts,
    progress_file: progressFile,
  };
  if (!final.ok) {
    out.error = a.error || `worker exited with code ${a.exitCode}`;
    out.error_class = a.error_class;
    if (final.rateInfo) {
      out.retry_after_sec = final.rateInfo.retry_after_sec;
      out.reset_at = final.rateInfo.reset_at || final.rateInfo.reset_at_raw;
    }
    out.stderr = truncate(a.stderr, 2000);
    if (a.diagnostics) out.diagnostics = a.diagnostics;
    emitRun(out, format);
    process.exit(a.error_class === 'timeout' ? 3 : a.exitCode || 1);
  }
  emitRun(out, format);
}

// Assemble the worker command line for one attempt.
function buildWorkerCommand(o) {
  const preamble = buildPreamble(o.progressFile);
  if (o.runner === 'opencode') {
    // opencode has no --allowedTools; tool restrictions live in opencode agent
    // configs (role "agent" → --agent). Warn instead of silently ignoring.
    if (o.tools && !o.isResume) {
      process.stderr.write(
        `Warning: "tools" is ignored for opencode runner (provider "${o.providerId}"). ` +
          `Restrict tools via an opencode agent and the role's "agent" field.\n`,
      );
    }
    // --dir pins the worker's working directory: opencode resolves it from the
    // environment (PWD), not from the child process cwd, so cwd alone is ignored.
    const args = ['run', '--model', o.model, '--format', 'json', '--pure', '--dir', o.cwd];
    // Headless workers cannot answer permission prompts. acceptEdits/
    // bypassPermissions map to opencode's --auto; anything else runs with
    // opencode's default permissions (read-mostly tasks).
    if (o.permissionMode === 'acceptEdits' || o.permissionMode === 'bypassPermissions') {
      args.push('--auto');
    }
    if (o.agentName) args.push('--agent', String(o.agentName));
    if (o.isResume && o.sessionId) args.push('--session', o.sessionId);
    // No --append-system-prompt equivalent → preamble goes into the message.
    args.push(preamble + '\n\n' + o.prompt);
    const env = applyWorkerStateDir({ ...process.env, PWD: o.cwd }, o.workerStateDir, 'opencode');
    return { cmd: 'opencode', args, env };
  }

  const env = buildWorkerEnv(o.provider, o.key, o.workerStateDir);
  // stream-json so the session_id is known from the first line — a worker killed
  // by the timeout or a dropped connection is otherwise unresumable.
  const args = [
    '-p',
    o.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    o.model,
    '--allowedTools',
    o.tools,
    '--permission-mode',
    o.permissionMode,
    '--max-turns',
    String(o.maxTurns),
    '--setting-sources',
    o.settingSources,
    '--strict-mcp-config',
    '--append-system-prompt',
    preamble,
  ];
  if (o.isResume && o.sessionId) args.push('--resume', o.sessionId);
  return { cmd: 'claude', args, env };
}

// Turn one raw worker run into a uniform attempt record.
function interpretAttempt(runner, raw, provider, model) {
  const base = {
    ok: false,
    sessionId: null,
    text: null,
    usage: extractUsage(null),
    cost_usd: null,
    cost_source: 'unavailable',
    cli_cost: null,
    num_turns: null,
    error: null,
    error_class: null,
    exitCode: raw.code,
    stderr: raw.stderr,
    diagnostics: null,
  };

  if (raw.spawnError) {
    return { ...base, error: raw.spawnError, error_class: 'error', exitCode: 1 };
  }

  if (runner === 'opencode') {
    const parsed = parseOpencodeOutput(raw.stdout);
    base.sessionId = parsed.sessionId;
    base.text = parsed.text || null;
    base.usage = parsed.usage;
    base.num_turns = parsed.steps || null;
    const cost = computeCost(provider, model, parsed.usage);
    base.cost_usd = cost.cost_usd;
    base.cost_source = cost.cost_source;
    if (base.cost_usd == null && parsed.cost != null) {
      base.cost_usd = Math.round(parsed.cost * 1e6) / 1e6;
      base.cost_source = 'opencode-reported';
    }
    base.cli_cost = parsed.cost;
    if (raw.timedOut) {
      return { ...base, error: 'timeout', error_class: 'timeout', exitCode: 3 };
    }
    if (!parsed.parsedAny) {
      const tail = truncate(raw.stderr || raw.stdout, 2000);
      const cls = classifyFailure({ text: tail, exitCode: raw.code, ok: false });
      return {
        ...base,
        error: 'unparseable worker output',
        error_class: cls,
        diagnostics: { stdout_tail: truncate(String(raw.stdout).slice(-1500), 1500) },
      };
    }
    const errText = parsed.errors.join('; ');
    const ok = raw.code === 0 && parsed.errors.length === 0;
    base.ok = ok;
    base.error_class = classifyFailure({ text: ok ? base.text : errText, exitCode: raw.code, ok });
    if (!ok || base.error_class) {
      // An opencode worker can exit 1 without an error event; surface what it did last.
      base.error = errText || (ok ? 'empty response' : `worker exited with code ${raw.code}`);
      base.diagnostics = {
        last_events: parsed.lastEvents,
        stdout_tail: truncate(String(raw.stdout).slice(-1500), 1500),
      };
    }
    return base;
  }

  // claude runner
  const parsed = parseClaudeStream(raw.stdout);
  base.sessionId = parsed.sessionId;
  if (raw.timedOut) {
    return {
      ...base,
      text: parsed.lastAssistantText,
      error: 'timeout',
      error_class: 'timeout',
      exitCode: 3,
    };
  }
  if (!parsed.result) {
    if (!parsed.parsedAny) {
      const tail = truncate(raw.stderr || raw.stdout, 2000);
      const cls = classifyFailure({ text: tail, exitCode: raw.code, ok: false });
      return { ...base, error: 'unparseable worker output', error_class: cls };
    }
    // Events arrived but no final result: the process died mid-stream.
    return {
      ...base,
      text: parsed.lastAssistantText,
      error: truncate(raw.stderr, 300) || 'worker stream ended without a result',
      error_class: 'transient',
    };
  }
  const r = parsed.result;
  base.usage = extractUsage(r);
  const cost = computeCost(provider, model, base.usage);
  base.cost_usd = cost.cost_usd;
  base.cost_source = cost.cost_source;
  base.cli_cost = r.total_cost_usd ?? null;
  base.num_turns = r.num_turns ?? null;
  base.text = r.result ?? null;
  const ok = raw.code === 0 && r.is_error !== true;
  base.ok = ok;
  base.error_class = classifyFailure({
    text: base.text,
    subtype: r.subtype,
    apiErrorStatus: r.api_error_status,
    exitCode: raw.code,
    ok,
  });
  if (!ok || base.error_class) {
    base.error = r.error || r.result || (ok ? 'empty response' : `worker exited with code ${raw.code}`);
  }
  return base;
}

function emitRun(out, format) {
  if (format === 'text') {
    process.stdout.write((out.result != null ? String(out.result) : '') + '\n');
    const meta = { ...out };
    delete meta.result;
    process.stderr.write(JSON.stringify(meta) + '\n');
  } else {
    process.stdout.write(JSON.stringify(out) + '\n');
  }
}

function emitError(obj, format, exitCode) {
  if (format === 'text') {
    process.stderr.write(JSON.stringify(obj) + '\n');
  } else {
    process.stdout.write(JSON.stringify(obj) + '\n');
  }
  process.exit(exitCode);
}

function runWorker(cmd, args, env, cwd, timeoutSec) {
  return new Promise((resolve) => {
    let child;
    try {
      // detached: give the worker its own process group so we can kill the whole
      // tree (worker + anything it spawned, e.g. a Bash tool) on timeout.
      child = spawn(cmd, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      resolve({ spawnError: e.message, stdout: '', stderr: '', code: 1 });
      return;
    }
    const pgid = child.pid; // == process group id because detached
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let killTimer = null;
    let reapTimer = null;

    const killGroup = (signal) => {
      try {
        process.kill(-pgid, signal); // negative pid → whole group
      } catch {
        try {
          child.kill(signal);
        } catch {}
      }
    };

    const settle = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (killTimer) clearTimeout(killTimer);
      if (reapTimer) clearTimeout(reapTimer);
      resolve(res);
    };

    const hardTimer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => {
        killGroup('SIGKILL');
        // If a lingering grandchild keeps the stdout pipe open, 'close' may never
        // fire. Settle shortly after SIGKILL so we never hang past the deadline.
        reapTimer = setTimeout(() => settle({ timedOut: true, stdout, stderr, code: null }), 1000);
      }, 5000);
    }, timeoutSec * 1000);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => settle({ spawnError: e.message, stdout, stderr, code: 1 }));
    child.on('close', (code) => {
      if (timedOut) settle({ timedOut: true, stdout, stderr, code });
      else settle({ stdout, stderr, code });
    });
  });
}

// ---------------------------------------------------------------------------
// Usage / dispatch
// ---------------------------------------------------------------------------

function printUsage() {
  process.stdout.write(
    `fleet.mjs — dispatch delegated claude workers to foreign providers

Usage:
  fleet.mjs doctor [--ping]
      List providers, key status (✓/✗), models, roles; check claude in PATH.
      --ping    minimal live 1-turn call per provider with a set key (exit 1 on any failure).

  fleet.mjs list
      Compact table of roles: role, provider, runner, resolved model, tools, permissionMode.

  fleet.mjs run (--role <name> | --provider <id> [--model <tier|literal>]) <task-source> [options]
      Task source (exactly one): --task "<text>" | --task-file <path> | stdin.
      Options:
        --model <tier|literal>   strong|default|fast, or a literal model name (overrides role).
        --cwd <dir>              working dir for the worker (default: cwd).
        --format json|text       default json.
        --resume <session-id>    continue a prior worker session.
        --timeout <sec>          hard timeout (overrides config defaults.timeoutSec).
        --max-turns <n>          override role/defaults (claude runner only).
        --permission-mode <m>    override role/defaults (opencode runner: acceptEdits/
                                 bypassPermissions map to opencode's --auto).
        --tools "<list>"         override role tools (claude runner only; opencode
                                 restricts tools via --agent / role "agent").
        --agent <name>           opencode agent to run the worker as (opencode runner).
        --progress-file <path>   checkpoint file the worker appends "- done: …" lines to
                                 (default: <task-file>.progress.md; "none" disables).
        --retries <n>            automatic retries for rate_limit / transient /
                                 empty_response failures (default defaults.maxRetries=3).
        --max-parallel <n>       concurrent workers allowed on the provider (default
                                 provider.maxParallel / defaults.maxParallelPerProvider=2;
                                 0 = unlimited). A run waits for a free slot.

Failure handling:
  Every failure carries an error_class: rate_limit, transient, empty_response, max_turns,
  timeout or error. transient/empty_response resume the same session (exponential backoff
  from defaults.retryBackoffSec=15). rate_limit continues the session on provider.fallback
  (same runner) or, if the reset time is within defaults.rateLimitWaitMaxSec, waits for it;
  otherwise the run fails with retry_after_sec/reset_at (set provider.rateLimitTz, e.g.
  "+08:00" for z.ai, so the reset wall clock can be interpreted). The output lists every
  attempt; session_id is reported even on timeout so the run can be resumed by hand.

Runners:
  Each provider runs on a runner: "claude" (default; headless claude -p against an
  Anthropic-compatible baseUrl) or "opencode" (opencode run; auth + model catalog come
  from the opencode CLI, model ids look like "opencode-go/glm-5.3").

Config search order:
  $FLEET_CONFIG → $CLAUDE_PROJECT_DIR/.claude/fleet.config.json →
  ./.claude/fleet.config.json → $CLAUDE_CONFIG_DIR/fleet.config.json →
  ~/.claude/fleet.config.json
  See fleet.config.example.json for the format.
`,
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    printUsage();
    process.exit(cmd ? 0 : 1);
  }

  try {
    switch (cmd) {
      case 'doctor':
        await cmdDoctor(argv.slice(1));
        break;
      case 'list':
        cmdList();
        break;
      case 'run':
        await cmdRun(argv.slice(1));
        break;
      default:
        process.stderr.write(`Unknown command: ${cmd}\n\n`);
        printUsage();
        process.exit(1);
    }
  } catch (err) {
    if (err instanceof FleetError) {
      die(err.message, err.exitCode);
    }
    // Unexpected: show message, not a stack, for cleanliness.
    die(`Unexpected error: ${err && err.message ? err.message : err}`, 1);
  }
}

main();
