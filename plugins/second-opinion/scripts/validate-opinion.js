#!/usr/bin/env node

/**
 * Validates second-opinion JSON output from stdin.
 *
 * Interface:
 *   stdin:  raw JSON string
 *   stdout: validated JSON (on success)
 *   stderr: error messages (on failure)
 *   exit 0: valid
 *   exit 1: invalid
 */

const fs = require('fs');

function validateOutput(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return { valid: false, errors: [`Not valid JSON: ${e.message}`] };
  }

  const errors = [];

  if (!parsed.source) errors.push('Missing: source');
  if (!parsed.problem_summary) errors.push('Missing: problem_summary');
  if (!parsed.analysis) errors.push('Missing: analysis');
  if (!Array.isArray(parsed.suggestions)) errors.push('Missing/invalid: suggestions');
  if (!parsed.root_cause_hypothesis) errors.push('Missing: root_cause_hypothesis');

  if (!parsed.status) {
    errors.push('Missing: status');
  } else if (!['resolved', 'partially_resolved', 'requires_user_input'].includes(parsed.status)) {
    errors.push('Invalid status value');
  }

  if (parsed.analysis && parsed.analysis.length < 20) {
    errors.push('Analysis too short (min 20 chars)');
  }

  if (parsed.remaining_concerns === undefined) {
    errors.push('Missing: remaining_concerns (use null if none)');
  }

  if (Array.isArray(parsed.suggestions)) {
    parsed.suggestions.forEach((s, i) => {
      if (!Array.isArray(s.verification_steps)) {
        errors.push(`suggestions[${i}] missing verification_steps`);
      }
    });
  }

  return { valid: errors.length === 0, errors };
}

function main() {
  let input = '';
  try {
    input = fs.readFileSync(0, 'utf8');
  } catch {
    console.error('No input on stdin');
    process.exit(1);
  }

  if (!input.trim()) {
    console.error('Empty input on stdin');
    process.exit(1);
  }

  const result = validateOutput(input);
  if (result.valid) {
    console.log(input);
    process.exit(0);
  } else {
    console.error(JSON.stringify(result));
    process.exit(1);
  }
}

main();
