#!/usr/bin/env node

/**
 * PostToolUse hook: Detects repeated errors and suggests /second-opinion.
 *
 * Reads tool result from stdin, extracts error signatures, tracks them in
 * a temp state file. When the same error appears >= 2 times, emits an
 * advisory additionalContext message.
 *
 * Loop prevention:
 * - 3-minute cooldown between suggestions
 * - Max 3 suggestions per 30-minute window (auto-resets)
 * - Advisory only (exit 0), Claude decides whether to act
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// --- Constants ---

const REPEAT_THRESHOLD = 2;
const COOLDOWN_MS = 3 * 60 * 1000; // 3 minutes
const MAX_OPINIONS = 3;
const OPINION_RESET_MS = 30 * 60 * 1000; // Reset opinion_count after 30 minutes

// --- Helpers ---

function getProjectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function projectHash(projectDir) {
  return crypto.createHash('md5').update(projectDir).digest('hex').substring(0, 10);
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
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
      // Normalize: strip file paths (Unix + Windows), line numbers, memory addresses
      const signature = match[1]
        .replace(/[A-Z]:\\[^\s:]+/g, '<path>')
        .replace(/\/.+?:\d+:\d+/g, '<path>')
        .replace(/0x[0-9a-f]+/gi, '<addr>')
        .replace(/\d{4,}/g, '<num>')
        .trim();
      return signature;
    }
  }

  return null;
}

/**
 * Extract text content from hook payload.
 * Covers multiple possible payload structures.
 */
function extractToolResultText(hookData) {
  const tr = hookData?.tool_result;
  if (!tr) return null;

  // Direct string
  if (typeof tr === 'string') return tr;

  // Common fields
  const candidates = [tr.stdout, tr.stderr, tr.output, tr.error, tr.content, tr.message];

  // If tool_result is an object with a nested content array (structured tool results)
  if (Array.isArray(tr.content)) {
    for (const block of tr.content) {
      if (typeof block === 'string') candidates.push(block);
      if (block?.text) candidates.push(block.text);
    }
  }

  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c;
  }

  // Last resort: stringify the whole thing
  try {
    const str = JSON.stringify(tr);
    if (str.length > 50) return str;
  } catch { /* ignore */ }

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
  const toolResult = extractToolResultText(hookData);

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
  const pHash = projectHash(projectDir);
  const statePath = path.join(os.tmpdir(), `second-opinion-${pHash}-errors.json`);

  // Read/init state
  let state = readJsonSafe(statePath) || {
    errors: [],
    last_opinion_timestamp: 0,
    opinion_count: 0,
  };

  // Reset opinion_count if last suggestion was long ago
  if (state.last_opinion_timestamp && (Date.now() - state.last_opinion_timestamp) > OPINION_RESET_MS) {
    state.opinion_count = 0;
  }

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
