#!/usr/bin/env node

/**
 * Codex CLI wrapper for plan and code reviews.
 *
 * Usage:
 *   node codex-review.js --type preflight|plan|step-review|final-review \
 *     --project-dir /path --plugin-root /path [--step-id N] [--resume] [--changes-summary "..."] [--mode prototype|production]
 *
 * Types:
 *   preflight     - Verify Codex CLI is available and working
 *   plan          - Review the implementation plan
 *   step-review   - Review a single step (requires --step-id)
 *   final-review  - Review all changes across all steps
 *
 * Flags:
 *   --plugin-root   Plugin root directory (for resolving schemas/standards)
 *   --resume        Resume previous Codex session for this review type
 *   --changes-summary  Summary of changes for focused re-reviews
 *   --mode          Pipeline mode: "prototype" (default) or "production"
 *
 * Output:
 *   JSON events on stdout (one per line): start, invoking_codex, session_expired, error, complete
 *   Review result written to .task/ via Codex --output-schema
 *
 * Exit codes:
 *   0 = success
 *   1 = validation error (output did not pass schema checks)
 *   2 = codex error (Codex CLI failed or timed out)
 *   3 = timeout
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// --- Constants ---

const TIMEOUT_MS = 8 * 60 * 1000; // 8 minutes (reduced from 20 to prevent resource exhaustion)
const EXIT_SUCCESS = 0;
const EXIT_VALIDATION = 1;
const EXIT_CODEX_ERROR = 2;
const EXIT_TIMEOUT = 3;
const EXIT_LOCKED = 4;

const VALID_TYPES = ['preflight', 'plan', 'step-review', 'final-review'];

const VALID_STATUSES = {
  plan: ['approved', 'needs_changes', 'needs_clarification', 'rejected'],
  'step-review': ['approved', 'needs_changes', 'rejected'],
  'final-review': ['approved', 'needs_changes', 'rejected'],
};

// --- JSON Events ---

function emitEvent(type, data = {}) {
  const event = { event: type, timestamp: new Date().toISOString(), ...data };
  console.log(JSON.stringify(event));
}

// --- Argument Parsing ---

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    type: null,
    projectDir: null,
    pluginRoot: null,
    stepId: null,
    resume: false,
    changesSummary: null,
    mode: 'prototype',
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--type':
        result.type = args[++i];
        break;
      case '--project-dir':
        result.projectDir = args[++i];
        break;
      case '--plugin-root':
        result.pluginRoot = args[++i];
        break;
      case '--step-id':
        result.stepId = args[++i];
        break;
      case '--resume':
        result.resume = true;
        break;
      case '--changes-summary':
        result.changesSummary = args[++i];
        break;
      case '--mode':
        result.mode = args[++i] === 'production' ? 'production' : 'prototype';
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

function readJsonSafe(filePath) {
  const content = readFileSafe(filePath);
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Aggregate all step-N-result.json files into a combined impl-result.json.
 * Returns the aggregated object, or null if no step results found.
 */
function aggregateStepResults(taskDir) {
  const stepResults = [];
  for (let n = 1; n <= 20; n++) {
    const stepPath = path.join(taskDir, `step-${n}-result.json`);
    const result = readJsonSafe(stepPath);
    if (result) {
      stepResults.push(result);
    } else if (n > 1) {
      break; // No more steps
    }
  }
  if (stepResults.length === 0) return null;

  const allComplete = stepResults.every(s => s.status === 'complete');
  const anyFailed = stepResults.some(s => s.status === 'failed');
  const hasUi = stepResults.some(s => s.has_ui_changes === true);
  const filesChanged = [...new Set(stepResults.flatMap(s => s.files_changed || []))];
  const testsWritten = [...new Set(stepResults.flatMap(s => s.tests_written || []))];

  return {
    status: anyFailed ? 'failed' : allComplete ? 'complete' : 'partial',
    has_ui_changes: hasUi,
    steps_completed: stepResults.map(s => s.step_id).filter(Boolean),
    files_changed: filesChanged,
    tests_written: testsWritten,
    notes: stepResults.filter(s => s.notes).map(s => `Step ${s.step_id}: ${s.notes}`).join('\n') || null,
  };
}

// --- Input Validation ---

function validateInputs(type, taskDir, pluginRoot, mode) {
  const errors = [];

  // Check .task/ directory exists
  if (!fs.existsSync(taskDir)) {
    errors.push(`.task/ directory not found at ${taskDir}`);
    return errors; // Can't check anything else
  }

  // Check schema files exist
  const schemaPath = getSchemaPath(pluginRoot, type);
  if (schemaPath && !fs.existsSync(schemaPath)) {
    errors.push(`Schema file not found: ${schemaPath}`);
  }

  // Type-specific input validation
  switch (type) {
    case 'plan': {
      const planMd = path.join(taskDir, 'plan.md');
      const planJson = path.join(taskDir, 'plan.json');
      if (!fs.existsSync(planMd)) errors.push('Missing required input: .task/plan.md');
      if (!fs.existsSync(planJson)) errors.push('Missing required input: .task/plan.json');
      break;
    }
    case 'step-review': {
      // stepId is validated separately in main()
      break;
    }
    case 'final-review': {
      const implResult = path.join(taskDir, 'impl-result.json');
      if (!fs.existsSync(implResult)) {
        // Auto-aggregate from step-N-result.json files
        const aggregated = aggregateStepResults(taskDir);
        if (aggregated) {
          fs.writeFileSync(implResult, JSON.stringify(aggregated, null, 2), 'utf8');
          console.error('[codex-review] Auto-aggregated impl-result.json from step results.');
        } else {
          errors.push('Missing required input: .task/impl-result.json (and no step-N-result.json files found to aggregate)');
        }
      }
      break;
    }
  }

  // Check standards file
  const standardsPath = getStandardsPath(pluginRoot, mode);
  if (standardsPath && !fs.existsSync(standardsPath)) {
    // Warning only, not a hard error
    console.error(`[codex-review] Warning: standards.md not found at ${standardsPath}`);
  }

  return errors;
}

// --- Error JSON Output ---

function writeErrorResult(outputPath, error, phase) {
  const errorResult = {
    status: 'error',
    error: typeof error === 'string' ? error : error.message || String(error),
    phase: phase || 'unknown',
    timestamp: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(outputPath, JSON.stringify(errorResult, null, 2), 'utf8');
  } catch (writeErr) {
    console.error(`[codex-review] Failed to write error result: ${writeErr.message}`);
  }
  return errorResult;
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

// --- Lockfile (prevent concurrent Codex processes) ---

const LOCK_STALE_MS = 10 * 60 * 1000; // Consider lock stale after 10 minutes

function acquireLock(taskDir) {
  const lockPath = path.join(taskDir, '.codex-review.lock');
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
          console.error(`[codex-review] Removing stale lock (age: ${Math.round(age / 1000)}s, pid: ${lock.pid})`);
        } catch { /* corrupt lock, remove it */ }
        try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
      }
    }
    // Atomic create — O_EXCL fails if file already exists
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, timestamp: Date.now() }));
    fs.closeSync(fd);
    return { acquired: true };
  } catch (err) {
    if (err.code === 'EEXIST') {
      return { acquired: false, pid: 'unknown', age: 0 };
    }
    // Filesystem error — fail closed (don't proceed)
    return { acquired: false, pid: 'unknown', age: 0 };
  }
}

function releaseLock(taskDir) {
  const lockPath = path.join(taskDir, '.codex-review.lock');
  try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
}

// --- Session Management ---

function getSessionMarker(taskDir, type, stepId) {
  switch (type) {
    case 'plan':
      return path.join(taskDir, '.codex-session-plan');
    case 'step-review':
      return path.join(taskDir, `.codex-session-step-${stepId}`);
    case 'final-review':
      return path.join(taskDir, '.codex-session-final');
    default:
      return null;
  }
}

function readSessionId(markerPath) {
  const content = readFileSafe(markerPath);
  if (!content) return null;
  return content.trim();
}

function writeSessionId(markerPath, sessionId) {
  try {
    fs.writeFileSync(markerPath, sessionId, 'utf8');
  } catch {
    // non-fatal
  }
}

// --- Output Path ---

function getOutputPath(taskDir, type, stepId) {
  switch (type) {
    case 'plan':
      return path.join(taskDir, 'plan-review.json');
    case 'step-review':
      return path.join(taskDir, `step-${stepId}-review.json`);
    case 'final-review':
      return path.join(taskDir, 'code-review.json');
    default:
      return path.join(taskDir, 'code-review.json');
  }
}

// --- Schema Resolution ---

function getSchemaPath(pluginRoot, type) {
  const schemaMap = {
    plan: 'plan-review.schema.json',
    'step-review': 'step-review.schema.json',
    'final-review': 'final-review.schema.json',
  };
  const schemaFile = schemaMap[type];
  if (!schemaFile || !pluginRoot) return null;
  return path.join(pluginRoot, 'docs', 'schemas', schemaFile);
}

function getStandardsPath(pluginRoot, mode) {
  if (!pluginRoot) return null;
  if (mode === 'prototype') {
    const prototypePath = path.join(pluginRoot, 'docs', 'standards-prototype.md');
    if (fs.existsSync(prototypePath)) return prototypePath;
    // Fallback to production standards if prototype file doesn't exist
  }
  return path.join(pluginRoot, 'docs', 'standards.md');
}

// --- Prompt Building ---

function buildPromptFilePaths(taskDir, projectDir, pluginRoot, type, stepId, changesSummary, mode) {
  const parts = [];

  // Pipeline mode context
  parts.push(`Pipeline mode: ${mode || 'prototype'}`);

  // Project CLAUDE.md — project-specific rules take precedence
  const claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    parts.push(`Project rules are defined in: ${claudeMdPath}\nThese project-specific rules take precedence over generic standards. Read and follow them.`);
  }

  // Standards reference
  const standardsPath = getStandardsPath(pluginRoot, mode);
  if (standardsPath && fs.existsSync(standardsPath)) {
    parts.push(`Review standards are defined in: ${standardsPath}`);
  }

  // Prompt reference document
  if (pluginRoot) {
    const promptDocMap = {
      plan: 'plan-reviewer.md',
      'step-review': 'code-reviewer.md',
      'final-review': 'code-reviewer.md',
    };
    const promptDoc = path.join(pluginRoot, 'docs', 'codex-prompts', promptDocMap[type]);
    if (fs.existsSync(promptDoc)) {
      parts.push(`Review criteria and output format are defined in: ${promptDoc}`);
    }
  }

  // Type-specific context
  switch (type) {
    case 'plan': {
      const planMd = path.join(taskDir, 'plan.md');
      const planJson = path.join(taskDir, 'plan.json');
      if (!fs.existsSync(planMd) || !fs.existsSync(planJson)) {
        throw new Error('Missing plan files. Expected .task/plan.md and .task/plan.json');
      }
      parts.push(`Review the implementation plan at: ${planMd}`);
      parts.push(`Structured plan data at: ${planJson}`);
      parts.push('Read relevant source files referenced in the plan to verify feasibility.');
      break;
    }
    case 'step-review': {
      const planJson = path.join(taskDir, 'plan.json');
      const stepResult = path.join(taskDir, `step-${stepId}-result.json`);
      if (!fs.existsSync(stepResult)) {
        throw new Error(`Missing step-${stepId}-result.json`);
      }
      parts.push(`Review ONLY the changes from step ${stepId}.`);
      parts.push(`Implementation plan: ${planJson}`);
      parts.push(`Step result: ${stepResult}`);
      parts.push('Run `git diff HEAD` to see the actual code changes.');
      parts.push('Read every changed file in full.');
      break;
    }
    case 'final-review': {
      const planJson = path.join(taskDir, 'plan.json');
      const implResult = path.join(taskDir, 'impl-result.json');
      if (!fs.existsSync(implResult)) {
        throw new Error('Missing impl-result.json');
      }
      parts.push('Review ALL implementation changes across all steps.');
      parts.push(`Implementation plan: ${planJson}`);
      parts.push(`Implementation result: ${implResult}`);
      parts.push('Run `git diff HEAD` to see all code changes.');
      parts.push('Read every changed file in full.');
      break;
    }
  }

  if (changesSummary) {
    parts.push(`\nFocused re-review. Changes since last review:\n${changesSummary}`);
  }

  return parts.join('\n\n');
}

// --- Shell Escaping ---

function shellEscape(str) {
  if (process.platform === 'win32') {
    // Windows: double-quote and escape inner double-quotes
    return '"' + str.replace(/"/g, '\\"') + '"';
  }
  // Unix: single-quote and escape inner single-quotes
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

// --- Codex Execution ---

async function runCodex(codexPath, prompt, outputPath, schemaPath, projectDir, sessionMarkerPath, resume) {
  return new Promise((resolve, reject) => {
    const args = [
      'exec',
      '--full-auto',
      '--skip-git-repo-check',
    ];

    if (schemaPath && fs.existsSync(schemaPath)) {
      args.push('--output-schema', schemaPath);
    }

    args.push('-o', outputPath);

    // Resume support
    if (resume) {
      const existingSession = readSessionId(sessionMarkerPath);
      if (existingSession) {
        args.push('--resume', existingSession);
        emitEvent('resuming_session', { session_id: existingSession });
      }
    }

    args.push(prompt);

    emitEvent('invoking_codex', { args: args.filter(a => a !== prompt).join(' ') });

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

      // Log stderr for debugging
      const taskDir = path.dirname(outputPath);
      if (stderr) {
        try {
          fs.writeFileSync(path.join(taskDir, 'codex_stderr.log'), stderr);
        } catch {
          // non-fatal
        }
      }

      if (timedOut) {
        reject(Object.assign(new Error(`Codex timed out after ${TIMEOUT_MS / 1000}s`), { exitCode: EXIT_TIMEOUT }));
        return;
      }

      // Check for session expiry pattern in stderr
      if (stderr.includes('session expired') || stderr.includes('Session expired')) {
        emitEvent('session_expired');
        // Clear session marker so next run starts fresh
        if (sessionMarkerPath) {
          try { fs.unlinkSync(sessionMarkerPath); } catch { /* ignore */ }
        }
      }

      // Try to extract session ID from stdout for future --resume
      const sessionMatch = stdout.match(/session[_-]id["\s:]+["']?([a-zA-Z0-9_-]+)["']?/i);
      if (sessionMatch && sessionMarkerPath) {
        writeSessionId(sessionMarkerPath, sessionMatch[1]);
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

// --- 5-Phase Output Validation ---

function validateOutput(outputPath, type, stepId) {
  const errors = [];

  // Phase 1: File exists
  if (!fs.existsSync(outputPath)) {
    return { valid: false, errors: [`Output file not found: ${outputPath}`] };
  }

  // Phase 2: Valid JSON
  const content = readFileSafe(outputPath);
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return { valid: false, errors: [`Output is not valid JSON: ${e.message}`] };
  }

  // Phase 3: Status field present and valid
  if (!parsed.status) {
    errors.push('Missing required field: status');
  } else {
    const validStatuses = VALID_STATUSES[type];
    if (validStatuses && !validStatuses.includes(parsed.status)) {
      errors.push(`Invalid status "${parsed.status}". Must be one of: ${validStatuses.join(', ')}`);
    }
  }

  // Phase 4: Type-specific required fields
  switch (type) {
    case 'plan':
      if (!parsed.summary) errors.push('Missing required field: summary');
      if (!Array.isArray(parsed.findings)) errors.push('Missing or invalid field: findings (must be array)');
      if (!parsed.requirements_coverage) errors.push('Missing required field: requirements_coverage');
      if (parsed.status === 'needs_clarification') {
        if (!parsed.clarification_questions || !Array.isArray(parsed.clarification_questions)) {
          errors.push('Status is needs_clarification but missing clarification_questions array');
        }
      }
      break;
    case 'step-review':
      if (!parsed.summary) errors.push('Missing required field: summary');
      if (typeof parsed.step_id !== 'number') errors.push('Missing or invalid field: step_id (must be number)');
      if (!parsed.step_adherence) errors.push('Missing required field: step_adherence');
      if (!Array.isArray(parsed.findings)) errors.push('Missing or invalid field: findings (must be array)');
      break;
    case 'final-review':
      if (!parsed.summary) errors.push('Missing required field: summary');
      if (!parsed.plan_adherence) errors.push('Missing required field: plan_adherence');
      if (!Array.isArray(parsed.findings)) errors.push('Missing or invalid field: findings (must be array)');
      if (!parsed.tests_review) errors.push('Missing required field: tests_review');
      if (!parsed.checklist) errors.push('Missing required field: checklist');
      break;
  }

  // Phase 5: Summary quality
  if (parsed.summary && parsed.summary.length < 10) {
    errors.push('Summary is too short (minimum 10 characters)');
  }

  return { valid: errors.length === 0, errors, parsed };
}

// --- Preflight ---

function runPreflight(codexPath) {
  if (!codexPath) {
    emitEvent('error', { message: 'Codex CLI not found' });
    console.error('[codex-review] Preflight FAILED: Codex CLI not found.');
    process.exit(EXIT_CODEX_ERROR);
  }

  try {
    execSync(`"${codexPath}" --help`, { stdio: 'pipe', timeout: 10000 });
    emitEvent('complete', { ok: true, codex_path: codexPath });
    console.error(`[codex-review] Preflight OK: Codex found at ${codexPath}`);
    process.exit(EXIT_SUCCESS);
  } catch (err) {
    emitEvent('error', { message: `Codex at ${codexPath} not responding: ${err.message}` });
    console.error(`[codex-review] Preflight FAILED: Codex found at ${codexPath} but not responding.`);
    process.exit(EXIT_CODEX_ERROR);
  }
}

// --- Main ---

async function main() {
  const { type, projectDir, pluginRoot, stepId, resume, changesSummary, mode } = parseArgs();

  if (!type || !VALID_TYPES.includes(type)) {
    console.error('Usage: codex-review.js --type preflight|plan|step-review|final-review --project-dir /path --plugin-root /path [--step-id N] [--resume] [--changes-summary "..."] [--mode prototype|production]');
    process.exit(EXIT_VALIDATION);
  }

  const codexPath = findCodex();

  // Preflight: verify Codex is available
  if (type === 'preflight') {
    runPreflight(codexPath);
    return;
  }

  // Non-preflight requires Codex
  if (!codexPath) {
    emitEvent('error', { message: 'Codex CLI not found. Cannot perform review.' });
    console.error('[codex-review] ERROR: Codex CLI not found. Install it or add it to PATH.');
    process.exit(EXIT_CODEX_ERROR);
  }

  if (type === 'step-review' && !stepId) {
    console.error('--step-id is required for step-review type');
    process.exit(EXIT_VALIDATION);
  }

  const dir = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const taskDir = path.join(dir, '.task');
  const outputPath = getOutputPath(taskDir, type, stepId);

  // Resolve plugin root (fallback: two levels up from this script)
  const resolvedPluginRoot = pluginRoot || path.resolve(__dirname, '..');
  const schemaPath = getSchemaPath(resolvedPluginRoot, type);
  const sessionMarkerPath = getSessionMarker(taskDir, type, stepId);

  // Input validation before starting Codex
  const inputErrors = validateInputs(type, taskDir, resolvedPluginRoot, mode);
  if (inputErrors.length > 0) {
    emitEvent('error', { message: 'Input validation failed', errors: inputErrors });
    console.error(`[codex-review] Input validation failed:\n${inputErrors.map(e => `  - ${e}`).join('\n')}`);
    writeErrorResult(outputPath, inputErrors.join('; '), type);
    process.exit(EXIT_VALIDATION);
  }

  // Prevent concurrent Codex processes (major cause of OOM/WSL crashes)
  const lock = acquireLock(taskDir);
  if (!lock.acquired) {
    emitEvent('error', { message: `Another Codex review is already running (pid: ${lock.pid}, age: ${lock.age}s). Aborting to prevent resource exhaustion.` });
    console.error(`[codex-review] BLOCKED: Another Codex process is running (pid: ${lock.pid}, started ${lock.age}s ago). Wait for it to finish.`);
    process.exit(EXIT_LOCKED);
  }

  // Ensure lock is released on exit
  const cleanupLock = () => releaseLock(taskDir);
  process.on('exit', cleanupLock);
  process.on('SIGTERM', () => { cleanupLock(); process.exit(1); });
  process.on('SIGINT', () => { cleanupLock(); process.exit(1); });

  emitEvent('start', { type, stepId: stepId || null, outputPath, resume, mode });

  console.error(`[codex-review] Starting ${type} review${stepId ? ` (step ${stepId})` : ''} [mode=${mode}] using Codex at ${codexPath}`);

  const MAX_RETRIES = 1; // One retry for session-expired
  let attempt = 0;
  let currentResume = resume;

  while (attempt <= MAX_RETRIES) {
    try {
      const prompt = buildPromptFilePaths(taskDir, dir, resolvedPluginRoot, type, stepId, changesSummary, mode);

      await runCodex(codexPath, prompt, outputPath, schemaPath, dir, sessionMarkerPath, currentResume);

      // Validate the output
      const validation = validateOutput(outputPath, type, stepId);

      if (!validation.valid) {
        emitEvent('error', {
          message: 'Output validation failed',
          errors: validation.errors,
        });
        console.error(`[codex-review] Validation failed:\n${validation.errors.map(e => `  - ${e}`).join('\n')}`);
        process.exit(EXIT_VALIDATION);
      }

      // Pretty-print the output JSON for readability
      try {
        fs.writeFileSync(outputPath, JSON.stringify(validation.parsed, null, 2), 'utf8');
      } catch { /* ignore formatting errors */ }

      emitEvent('complete', {
        type,
        stepId: stepId || null,
        status: validation.parsed.status,
        findings_count: validation.parsed.findings ? validation.parsed.findings.length : 0,
      });
      console.error(`[codex-review] ${type} review complete: ${validation.parsed.status}`);
      process.exit(EXIT_SUCCESS);
    } catch (err) {
      // Session-expired auto-retry: clear session marker and retry without --resume
      const isSessionExpired = err.message && (
        err.message.includes('session expired') ||
        err.message.includes('Session expired')
      );
      // Also check if stderr was captured with session expired
      const stderrHasExpiry = err.stderr && (
        err.stderr.includes('session expired') ||
        err.stderr.includes('Session expired')
      );

      if ((isSessionExpired || stderrHasExpiry) && attempt < MAX_RETRIES) {
        attempt++;
        emitEvent('session_expired_retry', { attempt });
        console.error(`[codex-review] Session expired. Clearing session marker and retrying (attempt ${attempt})...`);
        // Clear session marker
        if (sessionMarkerPath) {
          try { fs.unlinkSync(sessionMarkerPath); } catch { /* ignore */ }
        }
        // Retry without resume
        currentResume = false;
        continue;
      }

      const exitCode = err.exitCode || EXIT_CODEX_ERROR;
      emitEvent('error', { message: err.message, exitCode });
      console.error(`[codex-review] Codex review failed: ${err.message}`);
      writeErrorResult(outputPath, err.message, type);
      process.exit(exitCode);
    }
  }
}

main();
