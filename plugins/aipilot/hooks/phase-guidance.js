#!/usr/bin/env node

/**
 * UserPromptSubmit hook: Artifact-based phase detection and guidance injection.
 *
 * Determines the current pipeline phase by checking which .task/*.json files
 * exist and their status values — does NOT rely on state.json being up to date.
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

/**
 * Detect the current phase purely from artifacts in .task/.
 * Returns { phase, detail } where phase is a human-readable label.
 */
function detectPhase(taskDir) {
  const planMd = fileExists(path.join(taskDir, 'plan.md'));
  const planJson = fileExists(path.join(taskDir, 'plan.json'));
  const planReviewPath = path.join(taskDir, 'plan-review.json');
  const planReview = readJsonSafe(planReviewPath);
  const userFeedback = fileExists(path.join(taskDir, 'user-plan-feedback.json'));
  const implResult = readJsonSafe(path.join(taskDir, 'impl-result.json'));
  const codeReview = readJsonSafe(path.join(taskDir, 'code-review.json'));
  const uiReview = readJsonSafe(path.join(taskDir, 'ui-review.json'));

  // Find step artifacts
  const stepResults = [];
  const stepReviews = [];
  try {
    const files = fs.readdirSync(taskDir);
    for (const f of files) {
      const resultMatch = f.match(/^step-(\d+)-result\.json$/);
      if (resultMatch) {
        stepResults.push({ step: parseInt(resultMatch[1]), data: readJsonSafe(path.join(taskDir, f)) });
      }
      const reviewMatch = f.match(/^step-(\d+)-review\.json$/);
      if (reviewMatch) {
        stepReviews.push({ step: parseInt(reviewMatch[1]), data: readJsonSafe(path.join(taskDir, f)) });
      }
    }
  } catch {
    // .task/ might not be listable
  }

  // Phase 7: UI verification
  if (uiReview) {
    return { phase: 'Phase 7: UI Verification', detail: `Status: ${uiReview.status}` };
  }

  // Phase 6: Final review
  if (codeReview) {
    if (codeReview.status === 'needs_changes') {
      const criticalCount = (codeReview.findings || []).filter(f => f.severity === 'critical').length;
      const majorCount = (codeReview.findings || []).filter(f => f.severity === 'major').length;
      return {
        phase: 'Phase 6: Final Review',
        detail: `Status: needs_changes | ${criticalCount} critical, ${majorCount} major findings. Launch implementer to fix.`
      };
    }
    return { phase: 'Phase 6: Final Review', detail: `Status: ${codeReview.status}` };
  }

  // Phase 5: Implementation (check for impl-result or step artifacts)
  if (implResult) {
    return { phase: 'Phase 5: Implementation Complete', detail: `Status: ${implResult.status} | ${implResult.total_steps || '?'} steps` };
  }

  if (stepResults.length > 0 || stepReviews.length > 0) {
    const maxResultStep = stepResults.length > 0 ? Math.max(...stepResults.map(s => s.step)) : 0;
    const maxReviewStep = stepReviews.length > 0 ? Math.max(...stepReviews.map(s => s.step)) : 0;

    // Check if the latest step review needs changes
    if (maxReviewStep > 0) {
      const latestReview = stepReviews.find(s => s.step === maxReviewStep);
      if (latestReview && latestReview.data && latestReview.data.status === 'needs_changes') {
        return {
          phase: `Phase 5b: Reviewing Step ${maxReviewStep}`,
          detail: `Step ${maxReviewStep} needs fixes. Re-launch implementer with fix_findings.`
        };
      }
    }

    if (maxResultStep > maxReviewStep) {
      return {
        phase: `Phase 5b: Reviewing Step ${maxResultStep}`,
        detail: `Step ${maxResultStep} implemented, awaiting review.`
      };
    }

    // Latest review done, next step implementation
    const nextStep = maxReviewStep + 1;
    return {
      phase: `Phase 5a: Implementing Step ${nextStep}`,
      detail: `${maxReviewStep} steps reviewed so far.`
    };
  }

  // Phase 3/4: Plan revision / user review
  if (planReview) {
    if (planReview.status === 'needs_changes') {
      return { phase: 'Phase 3: Plan Revision', detail: 'Plan review returned needs_changes. Analyzer should revise.' };
    }
    if (planReview.status === 'needs_clarification') {
      return { phase: 'Phase 3: Clarification Needed', detail: 'Plan review needs clarification. Ask user via AskUserQuestion.' };
    }
    if (planReview.status === 'approved') {
      return { phase: 'Phase 4: User Review', detail: 'Plan approved by Codex. Waiting for user approval at .task/plan.md' };
    }
    if (planReview.status === 'rejected') {
      return { phase: 'Phase 2: Plan Rejected', detail: 'Plan was rejected by review. Escalate to user.' };
    }
    return { phase: 'Phase 2: Plan Review', detail: `Review status: ${planReview.status}` };
  }

  // Phase 2: Plan exists but no review yet
  if (planMd && planJson) {
    return { phase: 'Phase 2: Plan Review', detail: 'Plan created, awaiting Codex review.' };
  }

  // Phase 1: No plan yet
  if (!planMd && !planJson) {
    return { phase: 'Phase 1: Analyzing', detail: 'No plan artifacts yet. Analyzer should be running.' };
  }

  // Partial plan
  return { phase: 'Phase 1: Analyzing', detail: 'Plan partially created. Waiting for analyzer to finish.' };
}

function computeGuidance() {
  const projectDir = getProjectDir();
  const taskDir = path.join(projectDir, '.task');

  // Provide initialization guidance when .task/ is missing
  if (!fileExists(taskDir)) {
    return [
      '[PIPELINE] Not initialized.',
      '[PIPELINE] Step 1: Bash("${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.sh" init --project-dir "${CLAUDE_PROJECT_DIR}")',
      '[PIPELINE] Step 2: Create 4 tasks with TaskCreate + blockedBy, then Write pipeline-tasks.json with task IDs.',
      '[PIPELINE] Do NOT call Task() until pipeline-tasks.json exists.'
    ].join('\n');
  }

  // Check for pipeline-tasks.json gating artifact
  const pipelineTasks = readJsonSafe(path.join(taskDir, 'pipeline-tasks.json'));
  if (!pipelineTasks) {
    return [
      '[PIPELINE] .task/ exists but pipeline-tasks.json missing — initialization incomplete.',
      '[PIPELINE] Use TaskCreate to create 4 phase tasks with blockedBy dependencies.',
      '[PIPELINE] Then Write pipeline-tasks.json with the task IDs.',
      '[PIPELINE] Do NOT call Task() until pipeline-tasks.json exists.'
    ].join('\n');
  }

  const detected = detectPhase(taskDir);
  const messages = [];

  messages.push(`[PIPELINE] ${detected.phase}`);
  if (detected.detail) {
    messages.push(`[PIPELINE] ${detected.detail}`);
  }

  // Main Loop reminder
  messages.push('[PIPELINE] Main Loop: TaskList() → find unblocked pending task → execute → complete → repeat.');

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
