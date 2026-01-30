#!/usr/bin/env node

/**
 * UserPromptSubmit hook: Reads pipeline state and injects phase-specific guidance.
 *
 * This hook runs before every user prompt is processed. It checks the current
 * pipeline state and provides contextual guidance to the orchestrator.
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

function computeGuidance() {
  const projectDir = getProjectDir();
  const taskDir = path.join(projectDir, '.task');

  if (!fileExists(taskDir)) {
    return null;
  }

  const state = readJsonSafe(path.join(taskDir, 'state.json'));
  if (!state || state.phase === 'idle') {
    return null;
  }

  const planExists = fileExists(path.join(taskDir, 'plan.md'));
  const planJsonExists = fileExists(path.join(taskDir, 'plan.json'));
  const planReviewExists = fileExists(path.join(taskDir, 'plan-review.json'));
  const implResultExists = fileExists(path.join(taskDir, 'impl-result.json'));
  const codeReviewExists = fileExists(path.join(taskDir, 'code-review.json'));
  const uiReviewExists = fileExists(path.join(taskDir, 'ui-review.json'));

  const planReview = planReviewExists ? readJsonSafe(path.join(taskDir, 'plan-review.json')) : null;
  const codeReview = codeReviewExists ? readJsonSafe(path.join(taskDir, 'code-review.json')) : null;
  const implResult = implResultExists ? readJsonSafe(path.join(taskDir, 'impl-result.json')) : null;
  const uiReview = uiReviewExists ? readJsonSafe(path.join(taskDir, 'ui-review.json')) : null;

  const messages = [];

  messages.push(`[PIPELINE] Current phase: ${state.phase} | Iteration: ${state.iteration}`);

  switch (state.phase) {
    case 'analyzing':
      messages.push('[PIPELINE] Phase 1: Analyzer agent should be creating the plan.');
      if (!planExists) {
        messages.push('[PIPELINE] Waiting for .task/plan.md and .task/plan.json to be created.');
      }
      break;

    case 'plan_review':
      messages.push('[PIPELINE] Phase 2: Plan is being reviewed by Codex.');
      if (planReview) {
        messages.push(`[PIPELINE] Review status: ${planReview.status}`);
        if (planReview.status === 'needs_changes') {
          messages.push('[PIPELINE] Plan needs revision. Launch analyzer agent with review findings.');
        }
      }
      break;

    case 'plan_revision':
      messages.push('[PIPELINE] Phase 3: Analyzer is revising the plan based on review feedback.');
      break;

    case 'user_review':
      messages.push('[PIPELINE] Phase 4: Waiting for user to review and approve .task/plan.md');
      messages.push('[PIPELINE] Use AskUserQuestion to confirm approval.');
      break;

    case 'implementing':
      messages.push('[PIPELINE] Phase 5: Implementer agent is executing the plan.');
      if (implResult) {
        messages.push(`[PIPELINE] Implementation status: ${implResult.status}`);
        if (implResult.status === 'partial') {
          messages.push(`[PIPELINE] Blocked: ${implResult.blocked_reason}`);
        }
      }
      break;

    case 'code_review':
      messages.push('[PIPELINE] Phase 6: Code is being reviewed by Codex.');
      if (codeReview) {
        messages.push(`[PIPELINE] Code review status: ${codeReview.status}`);
        if (codeReview.status === 'needs_changes') {
          const criticalCount = (codeReview.findings || []).filter(f => f.severity === 'critical').length;
          const majorCount = (codeReview.findings || []).filter(f => f.severity === 'major').length;
          messages.push(`[PIPELINE] Findings: ${criticalCount} critical, ${majorCount} major. Launch implementer to fix.`);
        }
      }
      break;

    case 'ui_verification':
      messages.push('[PIPELINE] Phase 7: UI is being verified with Playwright.');
      if (uiReview) {
        messages.push(`[PIPELINE] UI review status: ${uiReview.status}`);
      }
      break;

    case 'complete':
      messages.push('[PIPELINE] Pipeline complete! All phases passed.');
      break;

    case 'failed':
      messages.push('[PIPELINE] Pipeline failed. Check .task/ artifacts for details.');
      break;
  }

  return messages.join('\n');
}

function main() {
  const guidance = computeGuidance();

  if (guidance) {
    const output = {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: guidance
      }
    };
    console.log(JSON.stringify(output));
  }

  process.exit(0);
}

main();
