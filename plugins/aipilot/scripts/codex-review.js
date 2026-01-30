#!/usr/bin/env node

/**
 * Codex CLI wrapper for plan and code reviews.
 *
 * Usage:
 *   node codex-review.js --type plan|code --project-dir /path/to/project
 *
 * This script:
 * 1. Reads the relevant input files
 * 2. Constructs a prompt for Codex
 * 3. Runs Codex CLI with the prompt
 * 4. Writes the review output to .task/
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { type: null, projectDir: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--type' && args[i + 1]) {
      result.type = args[i + 1];
      i++;
    }
    if (args[i] === '--project-dir' && args[i + 1]) {
      result.projectDir = args[i + 1];
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

function buildCodeReviewPrompt(taskDir, projectDir) {
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

  return `You are a code reviewer. Review the following implementation changes.

## Implementation Plan

${planJson || '(Not available)'}

## Implementation Result

${implResult}

## Git Diff

${gitDiff}

## Your Task

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

async function main() {
  const { type, projectDir } = parseArgs();

  if (!type || !['plan', 'code'].includes(type)) {
    console.error('Usage: codex-review.js --type plan|code --project-dir /path');
    process.exit(1);
  }

  const dir = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const taskDir = path.join(dir, '.task');

  // Find Codex
  const codexPath = findCodex();
  if (!codexPath) {
    console.error('Codex CLI not found. Install it or add it to PATH.');

    // Write a skip result with all required fields for review-gate validation
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
    } else {
      skipResult.plan_adherence = {
        steps_verified: [],
        deviations: ['Codex unavailable - manual review recommended']
      };
    }

    const outputFile = type === 'plan' ? 'plan-review.json' : 'code-review.json';
    fs.writeFileSync(path.join(taskDir, outputFile), JSON.stringify(skipResult, null, 2));
    process.exit(0);
  }

  try {
    let prompt;
    let outputPath;

    if (type === 'plan') {
      prompt = buildPlanReviewPrompt(taskDir);
      outputPath = path.join(taskDir, 'plan-review.json');
    } else {
      prompt = buildCodeReviewPrompt(taskDir, dir);
      outputPath = path.join(taskDir, 'code-review.json');
    }

    const result = await runCodex(codexPath, prompt, outputPath, dir, type);
    console.log(JSON.stringify({ success: true, status: result.status }));
  } catch (err) {
    console.error(`Codex review failed: ${err.message}`);
    process.exit(1);
  }
}

main();
