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

  return {
    parsedAny: events.length > 0,
    sessionId,
    text: texts.join('\n'),
    usage,
    cost: hasCost ? cost : null,
    steps,
    errors,
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

  const runner = runnerOf(provider);
  const workerStateDir = resolveWorkerStateDir(config);

  // Key — only the claude runner needs one; opencode authenticates itself.
  let key = null;
  if (runner === 'claude') {
    key = lookupKey(provider.apiKeyEnv, envFileValues);
    if (!key) {
      throw new FleetError(
        `API key not set for provider "${providerId}". Set env var ${provider.apiKeyEnv}, ` +
          `or add it to the configured envFile.`,
        2,
      );
    }
  }

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

  let cmd;
  let args;
  let env;
  if (runner === 'opencode') {
    // opencode has no --allowedTools; tool restrictions live in opencode agent
    // configs (role "agent" → --agent). Warn instead of silently ignoring.
    if (tools) {
      process.stderr.write(
        `Warning: "tools" is ignored for opencode runner (provider "${providerId}"). ` +
          `Restrict tools via an opencode agent and the role's "agent" field.\n`,
      );
    }
    cmd = 'opencode';
    // --dir pins the worker's working directory: opencode resolves it from the
    // environment (PWD), not from the child process cwd, so cwd alone is ignored.
    args = ['run', '--model', model, '--format', 'json', '--pure', '--dir', cwd];
    // Headless workers cannot answer permission prompts. acceptEdits/
    // bypassPermissions map to opencode's --auto; anything else runs with
    // opencode's default permissions (read-mostly tasks).
    if (permissionMode === 'acceptEdits' || permissionMode === 'bypassPermissions') {
      args.push('--auto');
    }
    const agentName =
      (flags.agent !== undefined && typeof flags.agent === 'string' && flags.agent) ||
      role?.agent;
    if (agentName) args.push('--agent', String(agentName));
    if (flags.resume !== undefined && typeof flags.resume === 'string') {
      args.push('--session', String(flags.resume));
    }
    // No --append-system-prompt equivalent → preamble goes into the message.
    args.push(WORKER_PREAMBLE + '\n\n' + task);
    env = applyWorkerStateDir({ ...process.env, PWD: cwd }, workerStateDir, 'opencode');
  } else {
    cmd = 'claude';
    env = buildWorkerEnv(provider, key, workerStateDir);
    args = [
      '-p',
      task,
      '--output-format',
      'json',
      '--model',
      model,
      '--allowedTools',
      tools,
      '--permission-mode',
      permissionMode,
      '--max-turns',
      String(maxTurns),
      '--setting-sources',
      settingSources,
      '--strict-mcp-config',
      '--append-system-prompt',
      WORKER_PREAMBLE,
    ];
    if (flags.resume !== undefined && typeof flags.resume === 'string') {
      args.push('--resume', String(flags.resume));
    }
  }

  const started = Date.now();
  const result = await runWorker(cmd, args, env, cwd, timeoutSec);
  const duration_ms = Date.now() - started;

  const base = { provider: providerId, model, role: roleName };

  // Timeout.
  if (result.timedOut) {
    emitError(
      { ...base, ok: false, error: 'timeout', duration_ms, stderr: truncate(result.stderr, 2000) },
      format,
      3,
    );
    return;
  }

  // Spawn error (e.g. claude not found).
  if (result.spawnError) {
    emitError(
      { ...base, ok: false, error: result.spawnError, duration_ms, stderr: '' },
      format,
      1,
    );
    return;
  }

  if (runner === 'opencode') {
    const parsed = parseOpencodeOutput(result.stdout);
    if (!parsed.parsedAny) {
      emitError(
        {
          ...base,
          ok: false,
          error: 'unparseable worker output',
          duration_ms,
          stderr: truncate(result.stderr || result.stdout, 2000),
        },
        format,
        result.code || 1,
      );
      return;
    }
    const isError = result.code !== 0 || parsed.errors.length > 0;
    // Config pricing wins; otherwise fall back to opencode's own cost figure
    // (models.dev pricing — notional on flat-rate plans like OpenCode Go).
    let { cost_usd, cost_source } = computeCost(provider, model, parsed.usage);
    if (cost_usd == null && parsed.cost != null) {
      cost_usd = Math.round(parsed.cost * 1e6) / 1e6;
      cost_source = 'opencode-reported';
    }
    const out = {
      ok: !isError,
      provider: providerId,
      model,
      role: roleName,
      session_id: parsed.sessionId,
      num_turns: parsed.steps || null,
      duration_ms,
      usage: parsed.usage,
      cost_usd,
      cost_source,
      cli_reported_cost_usd: parsed.cost,
      result: parsed.text || null,
    };
    if (isError) {
      out.error = parsed.errors.join('; ') || `worker exited with code ${result.code}`;
      out.stderr = truncate(result.stderr, 2000);
      emitRun(out, format);
      process.exit(result.code || 1);
    }
    emitRun(out, format);
    return;
  }

  // claude runner: a single JSON object on stdout.
  let cliJson = null;
  try {
    cliJson = JSON.parse(result.stdout);
  } catch {
    emitError(
      {
        ...base,
        ok: false,
        error: 'unparseable worker output',
        duration_ms,
        stderr: truncate(result.stderr || result.stdout, 2000),
      },
      format,
      result.code || 1,
    );
    return;
  }

  const isError = result.code !== 0 || cliJson.is_error === true;
  const usage = extractUsage(cliJson);
  const { cost_usd, cost_source } = computeCost(provider, model, usage);

  const out = {
    ok: !isError,
    provider: providerId,
    model,
    role: roleName,
    session_id: cliJson.session_id || null,
    num_turns: cliJson.num_turns ?? null,
    duration_ms,
    usage,
    cost_usd,
    cost_source,
    cli_reported_cost_usd: cliJson.total_cost_usd ?? null,
    result: cliJson.result ?? null,
  };

  if (isError) {
    out.error = cliJson.error || cliJson.result || `worker exited with code ${result.code}`;
    out.stderr = truncate(result.stderr, 2000);
    emitRun(out, format);
    process.exit(result.code || 1);
  }

  emitRun(out, format);
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

Runners:
  Each provider runs on a runner: "claude" (default; headless claude -p against an
  Anthropic-compatible baseUrl) or "opencode" (opencode run; auth + model catalog come
  from the opencode CLI, model ids look like "opencode-go/glm-5.2").

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
