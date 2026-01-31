#!/usr/bin/env node

/**
 * Second-opinion engine: gets an independent analysis from Codex CLI.
 *
 * Reads context from stdin, invokes Codex, prints result JSON to stdout.
 * All temp files are created in os.tmpdir() and cleaned up after use.
 *
 * Usage:
 *   echo "context..." | node get-opinion.js --project-dir <path> --plugin-root <path>
 *
 * Exit codes:
 *   0  = success (opinion JSON printed to stdout)
 *   1  = validation error
 *   2  = codex error
 *   3  = timeout
 *   4  = locked (another opinion process running)
 *   10 = codex not available (caller should fall back to Opus)
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// --- Constants ---

const TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
const LOCK_STALE_MS = 5 * 60 * 1000; // 5 minutes
const EXIT_SUCCESS = 0;
const EXIT_VALIDATION = 1;
const EXIT_CODEX_ERROR = 2;
const EXIT_TIMEOUT = 3;
const EXIT_LOCKED = 4;
const EXIT_NO_CODEX = 10;

const SECOND_OPINION_PROMPT = `You are a senior debugging specialist providing an independent second opinion. Another AI assistant has been working on this problem and is stuck. Your value comes from a fresh perspective — identify what was overlooked, not what was already tried.

<instructions>
1. Read the context file for the full problem description, prior attempts, errors, and relevant code
2. Read the referenced source files in the project to verify claims and gather additional context
3. Identify assumptions in the prior attempts that may be incorrect
4. Formulate your own root cause hypothesis based on the evidence
5. Propose 3-4 alternative approaches ordered by confidence level

Focus your analysis on:
- Root causes the prior attempts may have missed (look for off-by-one layers: is the real bug one function/file/abstraction level away from where they looked?)
- Environmental or configuration factors that could explain the behavior
- Interactions between components that may not be obvious from reading individual files
- Whether the error message is misleading and the actual failure point is elsewhere

Rate each suggestion's confidence honestly: "high" only when you have strong evidence from the code, "medium" when the reasoning is sound but unverified, "low" for speculative ideas worth investigating.
</instructions>`;

// --- Argument Parsing ---

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { projectDir: null, pluginRoot: null };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
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

function removeSafe(filePath) {
  try { fs.unlinkSync(filePath); } catch { /* ignore */ }
}

function projectHash(projectDir) {
  return crypto.createHash('md5').update(projectDir).digest('hex').substring(0, 10);
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

// --- Atomic Lockfile ---

function acquireLock(lockPath) {
  try {
    // Check for existing lock and stale detection
    if (fs.existsSync(lockPath)) {
      const lockContent = readFileSafe(lockPath);
      if (lockContent) {
        try {
          const lock = JSON.parse(lockContent);
          const age = Date.now() - lock.timestamp;
          if (age < LOCK_STALE_MS) {
            return { acquired: false, pid: lock.pid, age: Math.round(age / 1000) };
          }
        } catch { /* corrupt lock, remove it */ }
        removeSafe(lockPath);
      }
    }
    // Atomic create — O_EXCL fails if file already exists
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, timestamp: Date.now() }));
    fs.closeSync(fd);
    return { acquired: true };
  } catch (err) {
    if (err.code === 'EEXIST') {
      // Another process created the lock between our check and open
      return { acquired: false, pid: 'unknown', age: 0 };
    }
    // Filesystem error — fail closed (don't proceed)
    return { acquired: false, pid: 'unknown', age: 0 };
  }
}

function releaseLock(lockPath) {
  removeSafe(lockPath);
}

// --- Codex Execution ---

async function runCodex(codexPath, contextFilePath, outputPath, schemaPath, projectDir) {
  return new Promise((resolve, reject) => {
    const prompt = `${SECOND_OPINION_PROMPT}\n\nContext file to read: ${contextFilePath}`;

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

function validateOutput(content) {
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
  const { projectDir, pluginRoot } = parseArgs();

  const dir = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const resolvedPluginRoot = pluginRoot || path.resolve(__dirname, '..');
  const schemaPath = path.join(resolvedPluginRoot, 'docs', 'schemas', 'second-opinion.schema.json');
  const hash = projectHash(dir);
  const tmpDir = os.tmpdir();

  // Read context from stdin
  let context = '';
  try {
    context = fs.readFileSync(0, 'utf8');
  } catch {
    console.error('[second-opinion] No context provided on stdin.');
    process.exit(EXIT_VALIDATION);
  }

  if (!context.trim()) {
    console.error('[second-opinion] Empty context provided.');
    process.exit(EXIT_VALIDATION);
  }

  // Check for Codex
  const codexPath = findCodex();
  if (!codexPath) {
    console.error('[second-opinion] Codex CLI not found. Signaling fallback to Opus.');
    process.exit(EXIT_NO_CODEX);
  }

  // Acquire atomic lock
  const lockPath = path.join(tmpDir, `second-opinion-${hash}.lock`);
  const lock = acquireLock(lockPath);
  if (!lock.acquired) {
    console.error(`[second-opinion] BLOCKED: Another opinion process running (pid: ${lock.pid}, age: ${lock.age}s).`);
    process.exit(EXIT_LOCKED);
  }

  // Per-run temp directory (isolated from other processes)
  const runDir = fs.mkdtempSync(path.join(tmpDir, 'second-opinion-'));
  const contextFilePath = path.join(runDir, 'context.md');
  const outputPath = path.join(runDir, 'output.json');

  const cleanup = () => {
    releaseLock(lockPath);
    removeSafe(contextFilePath);
    removeSafe(outputPath);
    try { fs.rmdirSync(runDir); } catch { /* ignore */ }
  };

  process.on('exit', cleanup);
  process.on('SIGTERM', () => { cleanup(); process.exit(1); });
  process.on('SIGINT', () => { cleanup(); process.exit(1); });

  // Write context to temp file (Codex needs a file to read)
  fs.writeFileSync(contextFilePath, context, 'utf8');

  console.error(`[second-opinion] Starting opinion generation using Codex at ${codexPath}`);

  try {
    await runCodex(codexPath, contextFilePath, outputPath, schemaPath, dir);

    const outputContent = readFileSafe(outputPath);
    if (!outputContent) {
      console.error('[second-opinion] Codex produced no output file.');
      process.exit(EXIT_CODEX_ERROR);
    }

    const validation = validateOutput(outputContent);
    if (!validation.valid) {
      console.error(`[second-opinion] Validation failed:\n${validation.errors.map(e => `  - ${e}`).join('\n')}`);
      process.exit(EXIT_VALIDATION);
    }

    // Print validated JSON to stdout — this is the result
    console.log(outputContent);
    console.error(`[second-opinion] Opinion generated successfully.`);
    process.exit(EXIT_SUCCESS);
  } catch (err) {
    const exitCode = err.exitCode || EXIT_CODEX_ERROR;
    console.error(`[second-opinion] Failed: ${err.message}`);
    process.exit(exitCode);
  }
}

main();
