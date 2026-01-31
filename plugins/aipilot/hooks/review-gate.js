#!/usr/bin/env node

/**
 * SubagentStop hook: Validates review outputs and enforces quality gates.
 *
 * Runs when any subagent finishes. Checks if review artifacts exist and
 * are properly structured. Can BLOCK if reviews are invalid.
 *
 * Validates against the JSON schemas in docs/schemas/ and enforces:
 * - Valid JSON with required fields
 * - Valid status values (including needs_clarification for plan reviews)
 * - Required type-specific fields (summary, findings, etc.)
 * - Checklist presence in final reviews
 */

const fs = require('fs');
const path = require('path');

function getProjectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function fileExists(filePath) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function getModTimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function validatePlanReview(taskDir) {
  const reviewPath = path.join(taskDir, 'plan-review.json');
  if (!fileExists(reviewPath)) {
    return null; // Not a plan review agent
  }

  const review = readJsonSafe(reviewPath);
  if (!review) {
    return { decision: 'block', reason: 'plan-review.json exists but is not valid JSON.' };
  }

  if (!['approved', 'needs_changes', 'needs_clarification', 'rejected'].includes(review.status)) {
    return {
      decision: 'block',
      reason: `plan-review.json has invalid status: "${review.status}". Must be "approved", "needs_changes", "needs_clarification", or "rejected".`
    };
  }

  if (!review.summary || typeof review.summary !== 'string') {
    return {
      decision: 'block',
      reason: 'plan-review.json is missing "summary" string field.'
    };
  }

  if (!review.findings || !Array.isArray(review.findings)) {
    return {
      decision: 'block',
      reason: 'plan-review.json is missing "findings" array.'
    };
  }

  if (!review.requirements_coverage) {
    return {
      decision: 'block',
      reason: 'plan-review.json is missing "requirements_coverage" section.'
    };
  }

  // needs_clarification requires clarification_questions
  if (review.status === 'needs_clarification') {
    if (!review.clarification_questions || !Array.isArray(review.clarification_questions) || review.clarification_questions.length === 0) {
      return {
        decision: 'block',
        reason: 'plan-review.json has status "needs_clarification" but missing or empty "clarification_questions" array.'
      };
    }
  }

  return null; // Valid
}

function validateCodeReview(taskDir) {
  const reviewPath = path.join(taskDir, 'code-review.json');
  if (!fileExists(reviewPath)) {
    return null; // Not a code review agent
  }

  const review = readJsonSafe(reviewPath);
  if (!review) {
    return { decision: 'block', reason: 'code-review.json exists but is not valid JSON.' };
  }

  if (!['approved', 'needs_changes', 'rejected'].includes(review.status)) {
    return {
      decision: 'block',
      reason: `code-review.json has invalid status: "${review.status}". Must be "approved", "needs_changes", or "rejected".`
    };
  }

  if (!review.summary || typeof review.summary !== 'string') {
    return {
      decision: 'block',
      reason: 'code-review.json is missing "summary" string field.'
    };
  }

  if (!review.findings || !Array.isArray(review.findings)) {
    return {
      decision: 'block',
      reason: 'code-review.json is missing "findings" array.'
    };
  }

  if (!review.plan_adherence) {
    return {
      decision: 'block',
      reason: 'code-review.json is missing "plan_adherence" section.'
    };
  }

  if (!review.tests_review) {
    return {
      decision: 'block',
      reason: 'code-review.json is missing "tests_review" section.'
    };
  }

  if (!review.checklist) {
    return {
      decision: 'block',
      reason: 'code-review.json is missing "checklist" section (12-point standards checklist).'
    };
  }

  return null; // Valid
}

function validateImplResult(taskDir) {
  const resultPath = path.join(taskDir, 'impl-result.json');
  if (!fileExists(resultPath)) {
    return null; // Not an implementer agent
  }

  const result = readJsonSafe(resultPath);
  if (!result) {
    return { decision: 'block', reason: 'impl-result.json exists but is not valid JSON.' };
  }

  if (!['complete', 'partial', 'failed'].includes(result.status)) {
    return {
      decision: 'block',
      reason: `impl-result.json has invalid status: "${result.status}". Must be "complete", "partial", or "failed".`
    };
  }

  if (typeof result.has_ui_changes !== 'boolean') {
    return {
      decision: 'block',
      reason: 'impl-result.json is missing "has_ui_changes" boolean field.'
    };
  }

  return null; // Valid
}

function validateStepReview(taskDir, stepFile) {
  const reviewPath = path.join(taskDir, stepFile);
  const review = readJsonSafe(reviewPath);
  if (!review) {
    return { decision: 'block', reason: `${stepFile} exists but is not valid JSON.` };
  }

  if (!['approved', 'needs_changes', 'rejected'].includes(review.status)) {
    return {
      decision: 'block',
      reason: `${stepFile} has invalid status: "${review.status}". Must be "approved", "needs_changes", or "rejected".`
    };
  }

  if (typeof review.step_id !== 'number') {
    return {
      decision: 'block',
      reason: `${stepFile} is missing "step_id" number field.`
    };
  }

  if (!review.summary || typeof review.summary !== 'string') {
    return {
      decision: 'block',
      reason: `${stepFile} is missing "summary" string field.`
    };
  }

  if (!review.step_adherence) {
    return {
      decision: 'block',
      reason: `${stepFile} is missing "step_adherence" section.`
    };
  }

  if (!Array.isArray(review.findings)) {
    return {
      decision: 'block',
      reason: `${stepFile} is missing "findings" array.`
    };
  }

  return null; // Valid
}

function findRecentStepReviews(taskDir, now, threshold) {
  try {
    const files = fs.readdirSync(taskDir);
    return files.filter(f => {
      if (!/^step-\d+-review\.json$/.test(f)) return false;
      return (now - getModTimeMs(path.join(taskDir, f))) < threshold;
    });
  } catch {
    return [];
  }
}

function main() {
  const projectDir = getProjectDir();
  const taskDir = path.join(projectDir, '.task');

  if (!fileExists(taskDir)) {
    process.exit(0); // No pipeline active
    return;
  }

  // No pipeline-tasks.json → pipeline not fully initialized → skip validation
  if (!fileExists(path.join(taskDir, 'pipeline-tasks.json'))) {
    process.exit(0);
    return;
  }

  // Check which artifacts were recently modified (within last 30 seconds)
  const now = Date.now();
  const recentThreshold = 30000;

  const checks = [];

  const planReviewTime = getModTimeMs(path.join(taskDir, 'plan-review.json'));
  if (now - planReviewTime < recentThreshold) {
    checks.push(validatePlanReview(taskDir));
  }

  const codeReviewTime = getModTimeMs(path.join(taskDir, 'code-review.json'));
  if (now - codeReviewTime < recentThreshold) {
    checks.push(validateCodeReview(taskDir));
  }

  // Validate recently modified step-N-review.json files
  const recentStepReviews = findRecentStepReviews(taskDir, now, recentThreshold);
  for (const stepFile of recentStepReviews) {
    checks.push(validateStepReview(taskDir, stepFile));
  }

  const implResultTime = getModTimeMs(path.join(taskDir, 'impl-result.json'));
  if (now - implResultTime < recentThreshold) {
    checks.push(validateImplResult(taskDir));
  }

  // Find first blocking result
  for (const result of checks) {
    if (result && result.decision === 'block') {
      console.log(JSON.stringify(result));
      process.exit(0);
      return;
    }
  }

  // All clear
  process.exit(0);
}

main();
