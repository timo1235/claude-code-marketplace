#!/usr/bin/env node

/**
 * Codex CLI wrapper for plan and code reviews.
 *
 * Usage:
 *   node codex-review.js --type preflight|plan|step-review|final-review --project-dir /path [--step-id N]
 *
 * Types:
 *   preflight     - Verify Codex CLI is available and working → exits 0 with JSON { ok: true }
 *   plan          - Review the implementation plan → .task/plan-review.json
 *   step-review   - Review a single step (requires --step-id) → .task/step-N-review.json
 *   final-review  - Review all changes across all steps → .task/code-review.json
 *
 * This script:
 * 1. Reads the relevant input files
 * 2. Constructs a prompt for Codex CLI
 * 3. Runs Codex CLI with the prompt
 * 4. Writes the review output to .task/
 * 5. Logs to stderr for verification (check .task/codex_stderr.log)
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { type: null, projectDir: null, stepId: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--type' && args[i + 1]) {
      result.type = args[i + 1];
      i++;
    }
    if (args[i] === '--project-dir' && args[i + 1]) {
      result.projectDir = args[i + 1];
      i++;
    }
    if (args[i] === '--step-id' && args[i + 1]) {
      result.stepId = args[i + 1];
      i++;
    }
  }

  return result;
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function findCodex() {
  // Try common locations
  const candidates = [
    'codex',
    path.join(process.env.HOME || '', '.local', 'bin', 'codex'),
    '/usr/local/bin/codex',
  ];

  for (const candidate of candidates) {
    try {
      execSync(`which ${candidate}`, { stdio: 'pipe' });
      return candidate;
    } catch {
      // Continue
    }
  }

  return null;
}

function buildPlanReviewPrompt(taskDir) {
  const planMd = readFileSafe(path.join(taskDir, 'plan.md'));
  const planJson = readFileSafe(path.join(taskDir, 'plan.json'));

  if (!planMd || !planJson) {
    throw new Error('Missing plan files. Expected .task/plan.md and .task/plan.json');
  }

  return `You are a plan reviewer. Review the following implementation plan for correctness, completeness, feasibility, and security.

## Plan (Markdown)

${planMd}

## Plan (JSON)

${planJson}

## Your Task

Write a JSON review to stdout with this exact structure:

{
  "status": "approved|needs_changes|rejected",
  "summary": "One paragraph assessment",
  "findings": [
    {
      "severity": "critical|major|minor|suggestion",
      "category": "completeness|feasibility|security|design|testing|ordering",
      "step_id": 1,
      "description": "Issue description",
      "recommendation": "How to fix"
    }
  ],
  "requirements_coverage": {
    "fully_covered": [],
    "partially_covered": [],
    "missing": []
  },
  "verdict": "What must change (if not approved)"
}

Only output valid JSON. No other text.`;
}

function buildStepReviewPrompt(taskDir, projectDir, stepId) {
  const planJson = readFileSafe(path.join(taskDir, 'plan.json'));
  const stepResult = readFileSafe(path.join(taskDir, `step-${stepId}-result.json`));

  if (!stepResult) {
    throw new Error(`Missing step-${stepId}-result.json`);
  }

  let gitDiff = '';
  try {
    gitDiff = execSync('git diff HEAD', {
      cwd: projectDir,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });
  } catch {
    gitDiff = '(Could not get git diff)';
  }

  return `You are a code reviewer. Review ONLY the changes from step ${stepId} of the implementation plan.

## Implementation Plan

${planJson || '(Not available)'}

## Step ${stepId} Result

${stepResult}

## Git Diff

${gitDiff}

## Your Task

Review only step ${stepId}. Verify that everything in this step is complete and correct.

Write a JSON review to stdout with this exact structure:

{
  "step_id": ${stepId},
  "status": "approved|needs_changes",
  "summary": "One paragraph assessment of this step",
  "step_adherence": {
    "implemented": true,
    "correct": true,
    "notes": ""
  },
  "findings": [
    {
      "severity": "critical|major|minor|suggestion",
      "category": "bug|security|performance|quality|testing|dead-code",
      "file": "path/to/file",
      "line": 0,
      "description": "Issue description",
      "recommendation": "How to fix"
    }
  ],
  "verdict": "What must change (if not approved)"
}

Only output valid JSON. No other text.`;
}

function buildFinalReviewPrompt(taskDir, projectDir) {
  const planJson = readFileSafe(path.join(taskDir, 'plan.json'));
  const implResult = readFileSafe(path.join(taskDir, 'impl-result.json'));

  if (!implResult) {
    throw new Error('Missing impl-result.json');
  }

  let gitDiff = '';
  try {
    gitDiff = execSync('git diff HEAD', {
      cwd: projectDir,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });
  } catch {
    gitDiff = '(Could not get git diff)';
  }

  return `You are a code reviewer. Review ALL implementation changes across all steps. Verify overall completeness against the full plan.

## Implementation Plan

${planJson || '(Not available)'}

## Implementation Result (all steps)

${implResult}

## Git Diff

${gitDiff}

## Your Task

Review all changes together. Verify that every plan step was implemented correctly and the overall result is complete.

Write a JSON review to stdout with this exact structure:

{
  "status": "approved|needs_changes|rejected",
  "summary": "One paragraph assessment",
  "plan_adherence": {
    "steps_verified": [
      {"step_id": 1, "implemented": true, "correct": true, "notes": ""}
    ],
    "deviations": []
  },
  "findings": [
    {
      "severity": "critical|major|minor|suggestion",
      "category": "bug|security|performance|quality|testing|dead-code",
      "file": "path/to/file",
      "line": 0,
      "description": "Issue description",
      "recommendation": "How to fix"
    }
  ],
  "tests_review": {
    "coverage_adequate": true,
    "missing_tests": [],
    "test_quality": "Assessment"
  },
  "verdict": "What must change (if not approved)"
}

Only output valid JSON. No other text.`;
}

async function runCodex(codexPath, prompt, outputPath, projectDir, reviewType) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Codex timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);

    const child = spawn(codexPath, [
      '--approval-mode', 'full-auto',
      '--quiet',
      prompt
    ], {
      cwd: projectDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      clearTimeout(timeout);

      if (stderr) {
        fs.writeFileSync(
          path.join(projectDir, '.task', 'codex_stderr.log'),
          stderr
        );
      }

      // Try to extract JSON from stdout
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          fs.writeFileSync(outputPath, JSON.stringify(parsed, null, 2));
          resolve(parsed);
          return;
        } catch {
          // Fall through
        }
      }

      // If no valid JSON, create a needs_changes result with required fields
      const fallback = {
        status: 'needs_changes',
        summary: `Codex exited with code ${code} but did not produce valid JSON output.`,
        findings: [],
        verdict: 'Codex review could not be parsed. Manual review recommended.'
      };

      if (reviewType === 'plan') {
        fallback.requirements_coverage = {
          fully_covered: [],
          partially_covered: [],
          missing: ['Codex output could not be parsed - manual review recommended']
        };
      } else {
        fallback.plan_adherence = {
          steps_verified: [],
          deviations: ['Codex output could not be parsed - manual review recommended']
        };
      }
      fs.writeFileSync(outputPath, JSON.stringify(fallback, null, 2));
      resolve(fallback);
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function getOutputPath(taskDir, type, stepId) {
  switch (type) {
    case 'plan': return path.join(taskDir, 'plan-review.json');
    case 'step-review': return path.join(taskDir, `step-${stepId}-review.json`);
    case 'final-review': return path.join(taskDir, 'code-review.json');
    default: return path.join(taskDir, 'code-review.json');
  }
}

function buildSkipResult(type, stepId) {
  const skipResult = {
    status: 'needs_changes',
    summary: 'Codex CLI not available. Review skipped.',
    findings: [],
    verdict: 'Codex not installed. Pipeline continues without Codex gate.'
  };

  if (type === 'plan') {
    skipResult.requirements_coverage = {
      fully_covered: [],
      partially_covered: [],
      missing: ['Codex unavailable - manual review recommended']
    };
  } else if (type === 'step-review') {
    skipResult.step_id = parseInt(stepId, 10);
    skipResult.step_adherence = {
      implemented: false,
      correct: false,
      notes: 'Codex unavailable - manual review recommended'
    };
  } else {
    skipResult.plan_adherence = {
      steps_verified: [],
      deviations: ['Codex unavailable - manual review recommended']
    };
  }

  return skipResult;
}

async function main() {
  const { type, projectDir, stepId } = parseArgs();

  const validTypes = ['preflight', 'plan', 'step-review', 'final-review'];
  if (!type || !validTypes.includes(type)) {
    console.error('Usage: codex-review.js --type preflight|plan|step-review|final-review --project-dir /path [--step-id N]');
    process.exit(1);
  }

  // Find Codex early — needed for all types
  const codexPath = findCodex();

  // Preflight check: verify Codex is available and responds
  if (type === 'preflight') {
    if (!codexPath) {
      console.error('[codex-review] Preflight FAILED: Codex CLI not found.');
      console.log(JSON.stringify({ ok: false, error: 'Codex CLI not found. Install it or add it to PATH.' }));
      process.exit(1);
    }

    try {
      execSync(`${codexPath} --help`, { stdio: 'pipe', timeout: 10000 });
      console.error(`[codex-review] Preflight OK: Codex found at ${codexPath}`);
      console.log(JSON.stringify({ ok: true, codex_path: codexPath }));
      process.exit(0);
    } catch (err) {
      console.error(`[codex-review] Preflight FAILED: Codex found at ${codexPath} but not responding.`);
      console.log(JSON.stringify({ ok: false, error: `Codex at ${codexPath} not responding: ${err.message}` }));
      process.exit(1);
    }
  }

  if (type === 'step-review' && !stepId) {
    console.error('--step-id is required for step-review type');
    process.exit(1);
  }

  const dir = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const taskDir = path.join(dir, '.task');
  const outputPath = getOutputPath(taskDir, type, stepId);

  // Check Codex availability
  if (!codexPath) {
    console.error('Codex CLI not found. Install it or add it to PATH.');
    fs.writeFileSync(outputPath, JSON.stringify(buildSkipResult(type, stepId), null, 2));
    process.exit(0);
  }

  console.error(`[codex-review] Starting ${type} review${stepId ? ` (step ${stepId})` : ''} using Codex at ${codexPath}`);

  try {
    let prompt;

    switch (type) {
      case 'plan':
        prompt = buildPlanReviewPrompt(taskDir);
        break;
      case 'step-review':
        prompt = buildStepReviewPrompt(taskDir, dir, stepId);
        break;
      case 'final-review':
        prompt = buildFinalReviewPrompt(taskDir, dir);
        break;
    }

    const result = await runCodex(codexPath, prompt, outputPath, dir, type);
    console.error(`[codex-review] ${type} review complete: ${result.status}`);
    console.log(JSON.stringify({ success: true, type, stepId: stepId || null, status: result.status }));
  } catch (err) {
    console.error(`[codex-review] Codex review failed: ${err.message}`);
    process.exit(1);
  }
}

main();
