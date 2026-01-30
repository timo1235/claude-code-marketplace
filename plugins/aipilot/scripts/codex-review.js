#!/usr/bin/env node

/**
 * Codex CLI wrapper for plan and code reviews.
 *
 * Usage:
 *   node codex-review.js --type preflight|plan|step-review|final-review \
 *     --project-dir /path --plugin-root /path [--step-id N] [--resume] [--changes-summary "..."]
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

const TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
const EXIT_SUCCESS = 0;
const EXIT_VALIDATION = 1;
const EXIT_CODEX_ERROR = 2;
const EXIT_TIMEOUT = 3;

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

function getStandardsPath(pluginRoot) {
  if (!pluginRoot) return null;
  return path.join(pluginRoot, 'docs', 'standards.md');
}

// --- Prompt Building ---

function buildPromptFilePaths(taskDir, projectDir, pluginRoot, type, stepId, changesSummary) {
  const parts = [];

  // Standards reference
  const standardsPath = getStandardsPath(pluginRoot);
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
  const { type, projectDir, pluginRoot, stepId, resume, changesSummary } = parseArgs();

  if (!type || !VALID_TYPES.includes(type)) {
    console.error('Usage: codex-review.js --type preflight|plan|step-review|final-review --project-dir /path --plugin-root /path [--step-id N] [--resume] [--changes-summary "..."]');
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

  emitEvent('start', { type, stepId: stepId || null, outputPath, resume });

  console.error(`[codex-review] Starting ${type} review${stepId ? ` (step ${stepId})` : ''} using Codex at ${codexPath}`);

  try {
    const prompt = buildPromptFilePaths(taskDir, dir, resolvedPluginRoot, type, stepId, changesSummary);

    await runCodex(codexPath, prompt, outputPath, schemaPath, dir, sessionMarkerPath, resume);

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

    emitEvent('complete', {
      type,
      stepId: stepId || null,
      status: validation.parsed.status,
      findings_count: validation.parsed.findings ? validation.parsed.findings.length : 0,
    });
    console.error(`[codex-review] ${type} review complete: ${validation.parsed.status}`);
    process.exit(EXIT_SUCCESS);
  } catch (err) {
    const exitCode = err.exitCode || EXIT_CODEX_ERROR;
    emitEvent('error', { message: err.message, exitCode });
    console.error(`[codex-review] Codex review failed: ${err.message}`);
    process.exit(exitCode);
  }
}

main();
