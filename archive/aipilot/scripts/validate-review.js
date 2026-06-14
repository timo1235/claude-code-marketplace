#!/usr/bin/env node

/**
 * Review JSON validation and step-result aggregation.
 *
 * Usage:
 *   node validate-review.js --type plan|step-review|final-review --project-dir /path [--step-id N] [--task-dir /path]
 *   node validate-review.js --type aggregate --project-dir /path [--task-dir /path]
 *
 * Exit codes:
 *   0 = valid (or aggregate success)
 *   1 = validation failed (errors printed as JSON to stdout)
 */

const fs = require('fs');
const path = require('path');

// --- Constants ---

const VALID_STATUSES = {
  plan: ['approved', 'needs_changes', 'needs_clarification', 'rejected'],
  'step-review': ['approved', 'needs_changes', 'rejected'],
  'final-review': ['approved', 'needs_changes', 'rejected'],
};

// --- Argument Parsing ---

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    type: null,
    projectDir: null,
    stepId: null,
    taskDir: null,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--type':
        result.type = args[++i];
        break;
      case '--project-dir':
        result.projectDir = args[++i];
        break;
      case '--step-id':
        result.stepId = args[++i];
        break;
      case '--task-dir':
        result.taskDir = args[++i];
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

// --- Session Discovery ---

/**
 * Discover the latest session task directory by scanning for .task-* dirs.
 * Returns absolute path or null.
 */
function discoverLatestTaskDir(projectDir) {
  try {
    const entries = fs.readdirSync(projectDir);
    let latestDir = null;
    let latestTs = 0;

    for (const entry of entries) {
      if (!/^\.task-[a-f0-9]{6}$/.test(entry)) continue;
      const fullPath = path.join(projectDir, entry);

      try {
        const lstat = fs.lstatSync(fullPath);
        if (!lstat.isDirectory()) continue;
        if (lstat.isSymbolicLink()) continue;
      } catch { continue; }

      try {
        const resolved = fs.realpathSync(fullPath);
        if (!resolved.startsWith(projectDir + path.sep) && resolved !== projectDir) continue;
      } catch { continue; }

      let ts = 0;
      const tsFile = path.join(fullPath, '.session-ts');
      try {
        ts = parseInt(fs.readFileSync(tsFile, 'utf8').trim(), 10) || 0;
      } catch {
        try { ts = Math.floor(fs.statSync(fullPath).mtimeMs / 1000); } catch { ts = 0; }
      }

      if (ts > latestTs) {
        latestTs = ts;
        latestDir = fullPath;
      } else if (ts === latestTs && latestDir) {
        if (fullPath > latestDir) latestDir = fullPath;
      }
    }

    return latestDir;
  } catch {
    return null;
  }
}

/**
 * Resolve task directory from args, env var, or filesystem scan.
 * Returns absolute path or null.
 */
function validateDirSafe(dir, projectDir) {
  try {
    const lstat = fs.lstatSync(dir);
    if (!lstat.isDirectory() || lstat.isSymbolicLink()) return false;
    const resolved = fs.realpathSync(dir);
    if (!resolved.startsWith(projectDir + path.sep) && resolved !== projectDir) return false;
    return true;
  } catch { return false; }
}

function resolveTaskDir(args) {
  if (args.taskDir) {
    if (!validateDirSafe(args.taskDir, args.projectDir)) {
      console.log(JSON.stringify({ valid: false, errors: [`Invalid --task-dir: ${args.taskDir} (not a directory, is a symlink, or outside project)`] }));
      process.exit(1);
    }
    return args.taskDir;
  }

  const sid = process.env.AIPILOT_SESSION_ID;
  if (sid) {
    if (!/^[a-f0-9]{6}$/.test(sid)) {
      console.log(JSON.stringify({ valid: false, errors: [`Invalid AIPILOT_SESSION_ID: ${sid}`] }));
      process.exit(1);
    }
    const dir = path.join(args.projectDir, `.task-${sid}`);
    if (!validateDirSafe(dir, args.projectDir)) {
      console.log(JSON.stringify({ valid: false, errors: [`Session dir .task-${sid} is invalid (not a directory, is a symlink, or outside project)`] }));
      process.exit(1);
    }
    return dir;
  }

  const discovered = discoverLatestTaskDir(args.projectDir);
  if (!discovered) {
    console.log(JSON.stringify({ valid: false, errors: ['No session directory found. Run orchestrator.sh init first.'] }));
    process.exit(1);
  }
  return discovered;
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

// --- Aggregation ---

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

// --- Main ---

function main() {
  const args = parseArgs();
  const validTypes = ['plan', 'step-review', 'final-review', 'aggregate'];

  if (!args.type || !validTypes.includes(args.type)) {
    console.error('Usage: validate-review.js --type plan|step-review|final-review|aggregate --project-dir /path [--step-id N] [--task-dir /path]');
    process.exit(1);
  }

  if (!args.projectDir) {
    console.error('--project-dir is required');
    process.exit(1);
  }

  if (args.type === 'step-review' && !args.stepId) {
    console.error('--step-id is required for step-review type');
    process.exit(1);
  }

  const taskDir = resolveTaskDir(args);

  if (args.type === 'aggregate') {
    try {
      if (!fs.existsSync(taskDir)) {
        console.log(JSON.stringify({ valid: false, errors: [`Task directory not found: ${taskDir}`] }));
        process.exit(1);
      }
      const result = aggregateStepResults(taskDir);
      if (!result) {
        console.log(JSON.stringify({ valid: false, errors: ['No step-N-result.json files found'] }));
        process.exit(1);
      }
      fs.writeFileSync(path.join(taskDir, 'impl-result.json'), JSON.stringify(result, null, 2));
      console.log(JSON.stringify({ valid: true, status: result.status }));
      process.exit(0);
    } catch (err) {
      console.log(JSON.stringify({ valid: false, errors: [`Aggregation failed: ${err.message}`] }));
      process.exit(1);
    }
  }

  const outputPath = getOutputPath(taskDir, args.type, args.stepId);
  const validation = validateOutput(outputPath, args.type, args.stepId);
  console.log(JSON.stringify(validation));
  process.exit(validation.valid ? 0 : 1);
}

main();
