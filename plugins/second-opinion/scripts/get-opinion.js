#!/usr/bin/env node

/**
 * Second-opinion engine: gets an independent analysis from Codex CLI.
 *
 * Usage:
 *   node get-opinion.js --context-file <path> --project-dir <path> --plugin-root <path>
 *
 * Exit codes:
 *   0  = success (opinion written to .second-opinion/opinion.json)
 *   1  = validation error
 *   2  = codex error
 *   3  = timeout
 *   4  = locked (another opinion process running)
 *   10 = codex not available (caller should fall back to Opus)
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// --- Constants ---

const TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
const LOCK_STALE_MS = 5 * 60 * 1000; // 5 minutes
const EXIT_SUCCESS = 0;
const EXIT_VALIDATION = 1;
const EXIT_CODEX_ERROR = 2;
const EXIT_TIMEOUT = 3;
const EXIT_LOCKED = 4;
const EXIT_NO_CODEX = 10;

const SECOND_OPINION_PROMPT = `You are providing a second opinion on a problem another AI is stuck on. Analyze independently. Do NOT repeat what has been tried. Focus on alternative approaches, missed root causes, different debugging strategies.

Read the context file provided for the full problem description, what has been tried so far, and relevant code. Then analyze the situation and provide your independent assessment.`;

// --- Argument Parsing ---

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { contextFile: null, projectDir: null, pluginRoot: null };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--context-file':
        result.contextFile = args[++i];
        break;
      case '--project-dir':
        result.projectDir = args[++i];
        break;
      case '--plugin-root':
        result.pluginRoot = args[++i];
        break;
    }
  }

  return result;
}

// --- File Helpers ---

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// --- Codex CLI Discovery ---

function findCodex() {
  const candidates = [
    'codex',
    path.join(process.env.HOME || '', '.local', 'bin', 'codex'),
    '/usr/local/bin/codex',
  ];

  for (const candidate of candidates) {
    try {
      execSync(`which "${candidate}"`, { stdio: 'pipe' });
      return candidate;
    } catch {
      // continue
    }
  }

  return null;
}

// --- Lockfile ---

function acquireLock(opinionDir) {
  const lockPath = path.join(opinionDir, '.opinion.lock');
  try {
    if (fs.existsSync(lockPath)) {
      const lockContent = readFileSafe(lockPath);
      if (lockContent) {
        const lock = JSON.parse(lockContent);
        const age = Date.now() - lock.timestamp;
        if (age < LOCK_STALE_MS) {
          return { acquired: false, pid: lock.pid, age: Math.round(age / 1000) };
        }
        console.error(`[second-opinion] Removing stale lock (age: ${Math.round(age / 1000)}s, pid: ${lock.pid})`);
      }
    }
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, timestamp: Date.now() }), 'utf8');
    return { acquired: true };
  } catch {
    return { acquired: true };
  }
}

function releaseLock(opinionDir) {
  const lockPath = path.join(opinionDir, '.opinion.lock');
  try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
}

// --- Codex Execution ---

async function runCodex(codexPath, contextFile, outputPath, schemaPath, projectDir) {
  return new Promise((resolve, reject) => {
    const contextContent = readFileSafe(contextFile);
    if (!contextContent) {
      reject(new Error(`Cannot read context file: ${contextFile}`));
      return;
    }

    const prompt = `${SECOND_OPINION_PROMPT}\n\nContext file to read: ${contextFile}`;

    const args = [
      'exec',
      '--full-auto',
      '--skip-git-repo-check',
    ];

    if (schemaPath && fs.existsSync(schemaPath)) {
      args.push('--output-schema', schemaPath);
    }

    args.push('-o', outputPath);
    args.push(prompt);

    console.error(`[second-opinion] Invoking Codex CLI...`);

    const child = spawn(codexPath, args, {
      cwd: projectDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000);
    }, TIMEOUT_MS);

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      clearTimeout(timeout);

      if (stderr) {
        try {
          const logPath = path.join(path.dirname(outputPath), 'codex_stderr.log');
          fs.writeFileSync(logPath, stderr);
        } catch { /* non-fatal */ }
      }

      if (timedOut) {
        reject(Object.assign(new Error(`Codex timed out after ${TIMEOUT_MS / 1000}s`), { exitCode: EXIT_TIMEOUT }));
        return;
      }

      if (code !== 0) {
        reject(Object.assign(
          new Error(`Codex exited with code ${code}`),
          { exitCode: EXIT_CODEX_ERROR, stderr }
        ));
        return;
      }

      resolve({ stdout, stderr, code });
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(Object.assign(err, { exitCode: EXIT_CODEX_ERROR }));
    });
  });
}

// --- Output Validation ---

function validateOutput(outputPath) {
  if (!fs.existsSync(outputPath)) {
    return { valid: false, errors: [`Output file not found: ${outputPath}`] };
  }

  const content = readFileSafe(outputPath);
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return { valid: false, errors: [`Output is not valid JSON: ${e.message}`] };
  }

  const errors = [];

  if (!parsed.source) errors.push('Missing required field: source');
  if (!parsed.problem_summary) errors.push('Missing required field: problem_summary');
  if (!parsed.analysis) errors.push('Missing required field: analysis');
  if (!Array.isArray(parsed.suggestions)) errors.push('Missing or invalid field: suggestions (must be array)');
  if (!parsed.root_cause_hypothesis) errors.push('Missing required field: root_cause_hypothesis');

  if (parsed.analysis && parsed.analysis.length < 20) {
    errors.push('Analysis is too short (minimum 20 characters)');
  }

  return { valid: errors.length === 0, errors, parsed };
}

// --- Main ---

async function main() {
  const { contextFile, projectDir, pluginRoot } = parseArgs();

  if (!contextFile) {
    console.error('Usage: get-opinion.js --context-file <path> --project-dir <path> --plugin-root <path>');
    process.exit(EXIT_VALIDATION);
  }

  const dir = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const resolvedPluginRoot = pluginRoot || path.resolve(__dirname, '..');
  const opinionDir = path.join(dir, '.second-opinion');
  const outputPath = path.join(opinionDir, 'opinion.json');
  const schemaPath = path.join(resolvedPluginRoot, 'docs', 'schemas', 'second-opinion.schema.json');

  ensureDir(opinionDir);

  // Check for Codex
  const codexPath = findCodex();
  if (!codexPath) {
    console.error('[second-opinion] Codex CLI not found. Signaling fallback to Opus.');
    process.exit(EXIT_NO_CODEX);
  }

  // Acquire lock
  const lock = acquireLock(opinionDir);
  if (!lock.acquired) {
    console.error(`[second-opinion] BLOCKED: Another opinion process running (pid: ${lock.pid}, age: ${lock.age}s).`);
    process.exit(EXIT_LOCKED);
  }

  const cleanupLock = () => releaseLock(opinionDir);
  process.on('exit', cleanupLock);
  process.on('SIGTERM', () => { cleanupLock(); process.exit(1); });
  process.on('SIGINT', () => { cleanupLock(); process.exit(1); });

  console.error(`[second-opinion] Starting opinion generation using Codex at ${codexPath}`);

  try {
    await runCodex(codexPath, contextFile, outputPath, schemaPath, dir);

    const validation = validateOutput(outputPath);
    if (!validation.valid) {
      console.error(`[second-opinion] Validation failed:\n${validation.errors.map(e => `  - ${e}`).join('\n')}`);
      process.exit(EXIT_VALIDATION);
    }

    console.error(`[second-opinion] Opinion generated successfully.`);
    process.exit(EXIT_SUCCESS);
  } catch (err) {
    const exitCode = err.exitCode || EXIT_CODEX_ERROR;
    console.error(`[second-opinion] Failed: ${err.message}`);
    process.exit(exitCode);
  }
}

main();
