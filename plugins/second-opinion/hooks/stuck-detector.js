#!/usr/bin/env node

/**
 * PostToolUse hook: Detects repeated errors and suggests /second-opinion.
 *
 * Reads tool result from stdin, extracts error signatures, tracks them in
 * .second-opinion/error-state.json. When the same error appears >= 2 times,
 * emits an advisory additionalContext message.
 *
 * Loop prevention:
 * - 3-minute cooldown between suggestions
 * - Max 3 suggestions per session
 * - Advisory only (exit 0), Claude decides whether to act
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- Constants ---

const REPEAT_THRESHOLD = 2;
const COOLDOWN_MS = 3 * 60 * 1000; // 3 minutes
const MAX_OPINIONS = 3;
const STATE_FILE = 'error-state.json';

// --- Helpers ---

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

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Extract error signature from tool output.
 * Looks for common error patterns and normalizes them.
 */
function extractErrorSignature(text) {
  if (!text || typeof text !== 'string') return null;

  // Common error patterns (order matters — first match wins)
  const patterns = [
    // Node/JS errors
    /(?:Error|TypeError|ReferenceError|SyntaxError|RangeError):\s*(.+?)(?:\n|$)/,
    // Python errors
    /(?:Traceback[\s\S]*?)(\w+Error:\s*.+?)(?:\n|$)/,
    // Compilation errors
    /error(?:\[E\d+\])?:\s*(.+?)(?:\n|$)/i,
    // Exit code errors
    /(?:exited? with|exit code|returned?)\s+(?:code\s+)?(\d+)/i,
    // Command failed
    /(?:FAIL|FAILED|command failed)[\s:]*(.+?)(?:\n|$)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      // Normalize: strip file paths, line numbers, memory addresses
      const signature = match[1]
        .replace(/\/.+?:\d+:\d+/g, '<path>')
        .replace(/0x[0-9a-f]+/gi, '<addr>')
        .replace(/\d{4,}/g, '<num>')
        .trim();
      return signature;
    }
  }

  return null;
}

function hashSignature(signature) {
  return crypto.createHash('md5').update(signature).digest('hex').substring(0, 12);
}

// --- Main ---

function main() {
  // Read stdin (tool result)
  let input = '';
  try {
    input = fs.readFileSync(0, 'utf8');
  } catch {
    process.exit(0);
    return;
  }

  // Parse hook input
  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch {
    process.exit(0);
    return;
  }

  // Extract the tool result text
  const toolResult = hookData?.tool_result?.stdout
    || hookData?.tool_result?.stderr
    || hookData?.tool_result?.output
    || (typeof hookData?.tool_result === 'string' ? hookData.tool_result : null);

  if (!toolResult) {
    process.exit(0);
    return;
  }

  // Check if the output looks like an error
  const signature = extractErrorSignature(toolResult);
  if (!signature) {
    process.exit(0);
    return;
  }

  const hash = hashSignature(signature);
  const projectDir = getProjectDir();
  const opinionDir = path.join(projectDir, '.second-opinion');
  const statePath = path.join(opinionDir, STATE_FILE);

  ensureDir(opinionDir);

  // Read/init state
  let state = readJsonSafe(statePath) || {
    errors: [],
    last_opinion_timestamp: 0,
    opinion_count: 0,
  };

  // Find or create error entry
  let entry = state.errors.find(e => e.hash === hash);
  if (entry) {
    entry.count += 1;
    entry.timestamp = Date.now();
  } else {
    entry = { hash, signature, count: 1, timestamp: Date.now() };
    state.errors.push(entry);
  }

  // Prune old entries (older than 30 minutes)
  const pruneThreshold = Date.now() - 30 * 60 * 1000;
  state.errors = state.errors.filter(e => e.timestamp > pruneThreshold);

  // Write state
  try {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  } catch { /* non-fatal */ }

  // Check trigger conditions
  const shouldSuggest =
    entry.count >= REPEAT_THRESHOLD &&
    (Date.now() - state.last_opinion_timestamp) > COOLDOWN_MS &&
    state.opinion_count < MAX_OPINIONS;

  if (shouldSuggest) {
    // Update state with suggestion timestamp
    state.last_opinion_timestamp = Date.now();
    state.opinion_count += 1;
    try {
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
    } catch { /* non-fatal */ }

    const output = {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `[SECOND-OPINION] Same error detected ${entry.count} times: "${entry.signature}". Consider /second-opinion for a fresh perspective from an alternative AI model.`
      }
    };
    console.log(JSON.stringify(output));
  }

  process.exit(0);
}

main();
