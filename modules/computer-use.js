/**
 * SOTA Computer Use Agent - Graph-Theoretic State Management
 *
 * Full desktop control using macOS native tools (cliclick, osascript, screencapture)
 * with Claude Sonnet 4.6 (fast) and Opus 4.6 (powerful) as the vision+reasoning brain.
 *
 * Architecture:
 *   HANDS: cliclick (mouse), osascript (keyboard), screencapture (screen)
 *   BRAIN: Sonnet 4.6 (default, fast) -> Opus 4.6 (escalation on complexity/loops/stagnation)
 *   LOOP:  screenshot -> Claude analyzes -> returns tool_use -> execute -> screenshot -> repeat
 *   GRAPH: State graph where screenshots = vertices, actions = edges
 *     - TASK PLANNING: Agent decomposes complex tasks into numbered sub-goals (DAG)
 *     - CHECKPOINTS: Verified-good states marked as safe return points (marked vertices)
 *     - CYCLE DETECTION: Screenshot hash matching detects loops (back-edges in DFS)
 *     - RECOVERY ESCALATION: 4 levels of backtracking (try alt -> undo -> checkpoint -> clean slate)
 *     - MODEL ESCALATION: Sonnet -> Opus when stuck or task is complex
 *
 * Endpoints:
 *   POST /computer/agent       - Full agentic loop (give task, agent does it autonomously)
 *   POST /computer/agent/stream - SSE streaming of agent steps
 *   POST /computer/screenshot  - Capture screen
 *   POST /computer/action      - Execute single action
 *   POST /computer/actions     - Execute action sequence
 *   GET  /computer/info        - Screen size, mouse, front app
 *   GET  /computer/actions     - List supported actions
 *   POST /computer/app         - Activate app
 *   POST /computer/open        - Open URL/file
 */

const { execSync, spawn, execFile } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { TrajectoryGraph, listTrajectories, loadTrajectory, TRAJECTORY_DIR } = require('./trajectory');
const { getRelevantContext, learnFromTrajectory } = require('./learning');
const contextManager = require('../context-manager');
// Action enrichment: resolve coordinates to element names for trajectory SCENE descriptions
let _lastPreResolvedTarget = null; // Store last resolved target BEFORE action execution
let _lastPreResolvedIntent = null; // Store last assistant intent
const semanticSearch = require('./ax-semantic-search');
const http = require('http');
const axg = require('./ax-grounding');
const inputBridge = require('./input-bridge');
const { queryClaudeGrounding } = require("./claude-grounding");

const SCREENSHOT_DIR = '/tmp/capy-screenshots';
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024; // 4.5MB - safely under Claude's 5MB limit
try { fs.mkdirSync(SCREENSHOT_DIR, { recursive: true }); } catch (e) {}

// --- ShowUI-2B Grounding Worker ---
// Persistent Python child process for sub-second coordinate refinement
// Protocol: stdin/stdout JSON lines. Model stays warm in memory (~2.5GB).
const SHOWUI_ENABLED = false; // Replaced by claude-grounding.js
let _showuiProc = null;
let _showuiReady = false;
let _showuiCallbacks = {};
let _showuiBuffer = '';
let _showuiStats = { queries: 0, refined: 0, totalMs: 0, failures: 0 };

function _startShowUI() {
  if (_showuiProc && !_showuiProc.killed) return;
  if (!SHOWUI_ENABLED) return;
  const workerPath = path.join(__dirname, '..', 'showui-worker.py');
  if (!fs.existsSync(workerPath)) {
    console.log('[ShowUI] Worker not found: ' + workerPath);
    return;
  }
  console.log('[ShowUI] Starting worker: ' + workerPath);
  try {
    _showuiProc = spawn('/opt/homebrew/bin/python3.11', ['-u', workerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    console.log('[ShowUI] Worker spawned, PID: ' + (_showuiProc.pid || 'unknown'));
  } catch (spawnErr) {
    console.log('[ShowUI] Failed to spawn worker: ' + spawnErr.message);
    _showuiProc = null;
    return;
  }
  _showuiProc.stdout.on('data', (data) => {
    _showuiBuffer += data.toString();
    const lines = _showuiBuffer.split('\n');
    _showuiBuffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'ready') {
          console.log('[ShowUI] Worker ready (PID: ' + (_showuiProc ? _showuiProc.pid : '?') + ')');
        } else if (msg.type === 'model_loaded') {
          _showuiReady = true;
          console.log('[ShowUI] Model loaded and warm - refinement ACTIVE');
        } else if (msg.type === 'model_error') {
          console.log('[ShowUI] Model load FAILED: ' + (msg.error || 'unknown'));
        } else if (msg.id && _showuiCallbacks[msg.id]) {
          _showuiCallbacks[msg.id](msg);
          delete _showuiCallbacks[msg.id];
        }
      } catch (e) {
        console.log('[ShowUI] stdout parse error: ' + e.message + ' line: ' + line.slice(0, 100));
      }
    }
  });
  _showuiProc.stderr.on('data', (d) => {
    const s = d.toString().trim();
    if (s) console.log('[ShowUI] ' + s);
  });
  _showuiProc.on('exit', (exitCode) => {
    console.log('[ShowUI] Worker exited with code ' + exitCode);
    _showuiProc = null;
    _showuiReady = false;
    // Auto-retry after 5 seconds if enabled
    if (SHOWUI_ENABLED) {
      console.log('[ShowUI] Will auto-restart worker in 5s...');
      setTimeout(() => _startShowUI(), 5000);
    }
  });
  _showuiProc.on('error', (err) => {
    console.log('[ShowUI] Worker spawn error: ' + err.message);
    _showuiProc = null;
  });
}

/**
 * Query ShowUI-2B for element coordinates.
 * @param {string} imagePath - Path to screenshot
 * @param {string} query - Element description (e.g. "the submit button")
 * @param {number} timeoutMs - Max wait time
 * @returns {Promise<{coords: [number,number], pixels: [number,number], elapsed_ms: number}|null>}
 */
function queryShowUI(imagePath, query, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (!SHOWUI_ENABLED || !_showuiProc || _showuiProc.killed) {
      _startShowUI();
      if (!_showuiProc) { resolve(null); return; }
    }
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const timer = setTimeout(() => {
      delete _showuiCallbacks[id];
      _showuiStats.failures++;
      resolve(null);
    }, timeoutMs);
    _showuiCallbacks[id] = (msg) => {
      clearTimeout(timer);
      if (msg.error) {
        _showuiStats.failures++;
        resolve(null);
      } else {
        resolve(msg);
      }
    };
    try {
      _showuiProc.stdin.write(JSON.stringify({
        id,
        image: imagePath,
        query,
        screen_w: SCREEN_W,
        screen_h: SCREEN_H,
      }) + '\n');
    } catch (e) {
      clearTimeout(timer);
      delete _showuiCallbacks[id];
      resolve(null);
    }
  });
}

/**
 * Extract what Claude is trying to click from its reasoning text.
 * @param {string} text - Claude's text before the tool_use
 * @returns {string|null} - Element description for ShowUI query
 */
function extractClickTarget(text) {
  if (!text || text.length < 5) return null;
  // Pattern: "click on the X", "I'll click the X", "clicking the X"
  const patterns = [
    /(?:I'll|I will|Let me|I need to|I should|Going to|I'm going to)\s+click\s+(?:on\s+)?(?:the\s+)?(.+?)(?:\s+to\s+|\s+in\s+order|\s+so\s+|\s+at\s+|\s+which|\.|,|$)/i,
    /click(?:ing)?\s+(?:on\s+)?(?:the\s+)?["']([^"']+)["']/i,
    /click(?:ing)?\s+(?:on\s+)?(?:the\s+)?(.+?)(?:\s+button|\s+icon|\s+link|\s+tab|\s+menu|\s+field|\s+bar|\s+area|\s+at\s+|\.|,|\s*$)/i,
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m && m[1] && m[1].trim().length > 2 && m[1].trim().length < 60) {
      return m[1].trim();
    }
  }
  return null;
}

// Start ShowUI worker eagerly so model is warm by first click
if (SHOWUI_ENABLED) {
  setTimeout(() => _startShowUI(), 1000);
}

// --- Macro recording hook (BUG-03 FIX) ---
// Set by server.js to bridge computer-use actions into macro recorder
let _macroRecorderHook = null;
function setMacroRecorder(hook) { _macroRecorderHook = hook; }
function _notifyMacroRecorder(action, params, result) {
  if (_macroRecorderHook) {
    try { _macroRecorderHook(action, params, result); } catch (e) {}
  }
}

// ShowUI-2B: Pass click target description from agent loop to executeToolCall
let _lastClickTarget = null;

// PATCH: Navigation action detection for trajectory surprise suppression
const _NAV_KEYS = new Set(['Return', 'Enter', 'return', 'enter']);
function _isNavigationAction(action, input) {
  if (!action) return false;
  if (action === 'key' && input && _NAV_KEYS.has(String(input.text || '').trim())) return true;
  if (action === 'type' && input && String(input.text || '').includes('\n')) return true;
  if (action === 'left_click' && _lastClickTarget) {
    const t = _lastClickTarget.toLowerCase();
    if (t.includes('link') || t.includes('url') || t.includes('search') ||
        t.includes('result') || t.includes('submit') || t.includes('navigate')) return true;
  }
  return false;
}


/**
 * Compress a JPEG file until it's under MAX_IMAGE_BYTES.
 * Uses sips to progressively lower JPEG quality.
 * Returns the final file size in bytes.
 */
function compressImageFile(filepath, targetWidth) {
  const qualities = [55, 40, 30, 20];
  for (const q of qualities) {
    try {
      execSync(`sips --resampleWidth ${targetWidth || SCREEN_W} -s formatOptions ${q} "${filepath}" 2>/dev/null`, { timeout: 10000, stdio: 'pipe' });
      const stat = fs.statSync(filepath);
      if (stat.size <= MAX_IMAGE_BYTES) return stat.size;
    } catch (e) {}
  }
  // Last resort: shrink to 1024px wide at quality 15
  try {
    execSync(`sips --resampleWidth 1024 -s formatOptions 15 "${filepath}" 2>/dev/null`, { timeout: 10000, stdio: 'pipe' });
  } catch (e) {}
  return fs.statSync(filepath).size;
}

// --- Visual cursor indicator (capy-cursor compiled Swift binary) ---
const CURSOR_BIN = path.join(__dirname, '..', 'capy-cursor');
const CURSOR_SWIFT = path.join(__dirname, '..', 'capy-cursor.swift');
try {
  if (fs.existsSync(CURSOR_SWIFT) && !fs.existsSync(CURSOR_BIN)) {
    console.log('[ComputerUse] Compiling capy-cursor indicator...');
    execSync(`swiftc "${CURSOR_SWIFT}" -o "${CURSOR_BIN}" -framework Cocoa -O`, { timeout: 120000, stdio: 'pipe' });
    console.log('[ComputerUse] capy-cursor compiled successfully');
  }
} catch (e) {
  console.error('[ComputerUse] capy-cursor compilation failed (non-fatal):', e.message);
}

// --- Config ---
const BETA_FLAG = 'computer-use-2025-11-24';
const TOOL_VERSION = 'computer_20251124';
const MAX_ITERATIONS = 500;
const MAX_TOKENS = 4096;

// AI Gateway config
const AI_GATEWAY_HOST = 'ai-gateway.happycapy.ai';
const AI_GATEWAY_KEY = 'cc00f875633a4dca884e24f5ab6e0106';

// --- Tiered Model Escalation ---
// Start with Sonnet 4.6 (fast, ~2-3x faster per call) and escalate to Opus 4.6
// when the task is complex, the agent is stuck, or loops/stagnation detected.
const MODELS = {
  sonnet: {
    id: 'claude-sonnet-4-6',
    path: '/api/v1/bedrock/model/claude-sonnet-4-6/invoke',
    label: 'Sonnet 4.6',
  },
  opus: {
    id: 'claude-opus-4-6',
    path: '/api/v1/bedrock/model/claude-opus-4-6/invoke',
    label: 'Opus 4.6',
  },
};
const DEFAULT_MODEL = 'sonnet';
// Base escalation threshold. Actual threshold is adaptive:
//   - Simple tasks (no plan or 1-2 steps): base threshold (8 iterations)
//   - Complex tasks (3+ plan steps): base + planSteps (more room for Sonnet)
// Derivation: Sonnet needs ~2 iterations per simple step (action + verify).
// For a 5-step plan, Sonnet needs ~10 iterations minimum. Escalating at 4 would be premature.
const ESCALATION_THRESHOLD_BASE = 8;
const ANTHROPIC_MODEL = MODELS.opus.id; // For logging/display (legacy compat)

// --- Screen dimensions (logical, macOS) ---
let SCREEN_W = 1440;
let SCREEN_H = 900;
try {
  const bounds = execSync(`osascript -e 'tell application "Finder" to get bounds of window of desktop'`, { timeout: 5000 }).toString().trim();
  const parts = bounds.split(',').map(s => parseInt(s.trim()));
  SCREEN_W = parts[2] || 1440;
  SCREEN_H = parts[3] || 900;
} catch (e) {}

// --- Anthropic API image constraints & coordinate scaling ---
// The API constrains images to max 1568px longest edge and ~1.15 megapixels.
// If we send 1440x900 (1,296,000 px), it silently downsamples to ~1356x848.
// Claude returns coordinates in the DOWNSAMPLED space, but cliclick uses logical screen space.
// Fix: pre-resize screenshots to match what the API would downsample to,
// tell Claude the display is SCALED_W x SCALED_H, then scale coordinates back.
function _getScaleFactor(w, h) {
  const longEdgeScale = 1568 / Math.max(w, h);
  const totalPixelsScale = Math.sqrt(1_150_000 / (w * h));
  return Math.min(1.0, longEdgeScale, totalPixelsScale);
}
const SCALE_FACTOR = _getScaleFactor(SCREEN_W, SCREEN_H);
const SCALED_W = Math.floor(SCREEN_W * SCALE_FACTOR);
const SCALED_H = Math.floor(SCREEN_H * SCALE_FACTOR);
console.log(`[ComputerUse] Screen: ${SCREEN_W}x${SCREEN_H}, Scale: ${SCALE_FACTOR.toFixed(4)}, Scaled: ${SCALED_W}x${SCALED_H}`);

// ============================================================
// INPUT VALIDATION (BUG-05, 06, 09, 11, 12, 13, 20 FIXES)
// ============================================================

// Actions that require a coordinate parameter
const COORD_ACTIONS = new Set([
  'left_click', 'right_click', 'middle_click', 'double_click',
  'triple_click', 'mouse_move', 'left_mouse_down', 'left_mouse_up'
]);

/**
 * Validate and normalize action parameters before execution.
 * Returns { valid: true, params } on success, { valid: false, error } on failure.
 */
function validateParams(action, params) {
  const p = { ...params };

  // --- Normalize camelCase to snake_case (BUG-05 FIX) ---
  if (p.startCoordinate && !p.start_coordinate) p.start_coordinate = p.startCoordinate;
  if (p.scrollDirection && !p.scroll_direction) p.scroll_direction = p.scrollDirection;
  if (p.scrollAmount && !p.scroll_amount) p.scroll_amount = p.scrollAmount;

  // --- Validate coordinate for click/move actions (BUG-11, 12, 13, 20 FIXES) ---
  if (COORD_ACTIONS.has(action)) {
    if (!p.coordinate || !Array.isArray(p.coordinate)) {
      return { valid: false, error: `"coordinate" is required for ${action} and must be an array [x, y]` };
    }
    if (p.coordinate.length < 2) {
      return { valid: false, error: `"coordinate" must have at least 2 elements [x, y], got ${p.coordinate.length}` };
    }
    // Truncate to exactly 2 elements with warning (BUG-20)
    if (p.coordinate.length > 2) {
      console.warn(`[Validate] coordinate has ${p.coordinate.length} elements, using first 2`);
      p.coordinate = p.coordinate.slice(0, 2);
    }
    const [x, y] = p.coordinate;
    if (typeof x !== 'number' || typeof y !== 'number' || isNaN(x) || isNaN(y)) {
      return { valid: false, error: `coordinate values must be numbers, got [${typeof x}, ${typeof y}]` };
    }
    // Warn but allow out-of-bounds (BUG-13 - log it)
    if (x < 0 || y < 0 || x > SCREEN_W || y > SCREEN_H) {
      console.warn(`[Validate] coordinate [${x},${y}] is outside screen bounds (${SCREEN_W}x${SCREEN_H})`);
    }
  }

  // --- Validate start_coordinate for drag (BUG-05 FIX) ---
  if (action === 'left_click_drag') {
    if (!p.start_coordinate || !Array.isArray(p.start_coordinate)) {
      return { valid: false, error: `"start_coordinate" (or "startCoordinate") is required for left_click_drag` };
    }
    if (!p.coordinate || !Array.isArray(p.coordinate)) {
      return { valid: false, error: `"coordinate" (destination) is required for left_click_drag` };
    }
    const [x1, y1] = p.start_coordinate;
    const [x2, y2] = p.coordinate;
    if (typeof x1 !== 'number' || typeof y1 !== 'number' || isNaN(x1) || isNaN(y1)) {
      return { valid: false, error: `start_coordinate values must be numbers` };
    }
    if (typeof x2 !== 'number' || typeof y2 !== 'number' || isNaN(x2) || isNaN(y2)) {
      return { valid: false, error: `coordinate values must be numbers` };
    }
  }

  // --- Validate zoom region (BUG-06 FIX) ---
  if (action === 'zoom') {
    if (!p.region || !Array.isArray(p.region) || p.region.length < 4) {
      // Fallback: if coordinate given, create a zoom region around it
      if (p.coordinate && Array.isArray(p.coordinate) && p.coordinate.length >= 2) {
        const [cx, cy] = p.coordinate;
        const zoomSize = p.amount || 200;
        p.region = [
          Math.max(0, cx - zoomSize), Math.max(0, cy - zoomSize),
          Math.min(SCREEN_W, cx + zoomSize), Math.min(SCREEN_H, cy + zoomSize)
        ];
      } else {
        return { valid: false, error: `"region" [x1,y1,x2,y2] or "coordinate" [x,y] is required for zoom` };
      }
    }
  }

  // --- Validate text for type/key (BUG-09 partial) ---
  if ((action === 'type' || action === 'key') && (p.text === undefined || p.text === null)) {
    return { valid: false, error: `"text" is required for ${action}` };
  }

  return { valid: true, params: p };
}

// ============================================================
// CORE ACTIONS - matching Claude Computer Use computer_20251124
// ============================================================

const ACTIONS = {
  screenshot(params = {}) {
    const filename = `screen-${Date.now()}.jpg`;
    const filepath = path.join(SCREENSHOT_DIR, filename);
    let regionArgs = '';
    if (params.region && Array.isArray(params.region) && params.region.length === 4) {
      const [x1, y1, x2, y2] = params.region;
      regionArgs = `-R${x1},${y1},${x2 - x1},${y2 - y1}`;
    }

    // TCC FIX: Use capy-screenshot.sh helper that routes through Terminal.app
    // when direct screencapture fails (node runs from launchd, not Terminal)
    const helperPath = path.join(__dirname, '..', 'capy-screenshot.sh');
    try {
      execSync(`"${helperPath}" "${filepath}" "${regionArgs}"`, { timeout: 15000, stdio: 'pipe' });
    } catch (err) {
      const stderr = (err.stderr || '').toString().trim();
      throw new Error(`screencapture failed: ${stderr || err.message}. Check Screen Recording permissions.`);
    }

    if (!fs.existsSync(filepath) || fs.statSync(filepath).size < 100) {
      throw new Error('screencapture produced empty or missing file');
    }
    // Resize to SCALED dimensions so Claude sees the same resolution it returns coordinates in
    try { execSync(`sips --resampleWidth ${SCALED_W} -s formatOptions 85 "${filepath}" 2>/dev/null`, { timeout: 10000, stdio: 'pipe' }); } catch (e) {}
    let stat = fs.statSync(filepath);
    if (stat.size > MAX_IMAGE_BYTES) {
      console.log(`[Screenshot] ${(stat.size/1024/1024).toFixed(1)}MB exceeds limit, compressing...`);
      compressImageFile(filepath, SCALED_W);
    }
    const data = fs.readFileSync(filepath);
    _cleanupScreenshots();
    return { type: 'screenshot', path: filepath, base64: data.toString('base64'), size: data.length, screen: { width: SCALED_W, height: SCALED_H }, mediaType: 'image/jpeg' };
  },

  left_click(params) {
    let [x, y] = params.coordinate;
    // PATCHED: AX snap -- correct coordinates to nearest accessible element
    const _snap = axg.snap(x, y);
    if (_snap.snapped) { x = _snap.x; y = _snap.y; }
    if (params.text) _pressModifier(params.text, 'down');
    _cliclick(`c:${Math.round(x)},${Math.round(y)}`);
    if (params.text) _pressModifier(params.text, 'up');
    _showCursor('click', x, y, _snap.snapped ? `AX:${_snap.element}` : 'click');
    axg.invalidateCache(); // UI changed after click
    return { action: 'left_click', coordinate: [x, y], axSnap: _snap.snapped ? _snap : undefined };
  },

  right_click(params) {
    let [x, y] = params.coordinate;
    const _snap = axg.snap(x, y);
    if (_snap.snapped) { x = _snap.x; y = _snap.y; }
    _cliclick(`rc:${Math.round(x)},${Math.round(y)}`);
    _showCursor('right_click', x, y, _snap.snapped ? `AX:${_snap.element}` : 'right click');
    axg.invalidateCache();
    return { action: 'right_click', coordinate: [x, y], axSnap: _snap.snapped ? _snap : undefined };
  },

  middle_click(params) {
    const [x, y] = params.coordinate;
    _cliclick(`c:${Math.round(x)},${Math.round(y)}`);
    _showCursor('click', x, y, 'click');
    return { action: 'middle_click', coordinate: [x, y], note: 'emulated on macOS' };
  },

  double_click(params) {
    let [x, y] = params.coordinate;
    const _snap = axg.snap(x, y);
    if (_snap.snapped) { x = _snap.x; y = _snap.y; }
    _cliclick(`dc:${Math.round(x)},${Math.round(y)}`);
    _showCursor('click', x, y, _snap.snapped ? `AX:${_snap.element}` : 'dbl click');
    axg.invalidateCache();
    return { action: 'double_click', coordinate: [x, y], axSnap: _snap.snapped ? _snap : undefined };
  },

  triple_click(params) {
    const [x, y] = params.coordinate;
    _cliclick(`tc:${Math.round(x)},${Math.round(y)}`);
    _showCursor('click', x, y, 'triple click');
    return { action: 'triple_click', coordinate: [x, y] };
  },

  mouse_move(params) {
    const [x, y] = params.coordinate;
    _cliclick(`m:${Math.round(x)},${Math.round(y)}`);
    _showCursor('click', x, y, 'move');
    return { action: 'mouse_move', coordinate: [x, y] };
  },

  // BUG-08 FIX: Handle \n newlines by splitting into lines + Return keypresses
  type(params) {
    const text = params.text;
    const lines = text.split('\n');
    let totalLen = 0;
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (line.length > 0) {
        const chunks = line.match(/.{1,200}/g) || [line];
        for (const chunk of chunks) {
          _cliclick(`t:"${chunk.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
          if (chunks.length > 1) _sleep(15);
        }
        totalLen += line.length;
      }
      // Insert Return key between lines (not after last line)
      if (li < lines.length - 1) {
        _cliclick('kp:return');  // PATCHED: cliclick instead of osascript (TCC fix)
        _sleep(10);
        totalLen += 1;
      }
    }
    axg.invalidateCache();
    return { action: 'type', length: totalLen };
  },

    // PATCHED: Use cliclick kp:/kd:/ku: instead of osascript (fixes TCC keystroke permission)
  key(params) {
    const keyStr = params.text;
    const parts = keyStr.split('+').map(k => k.trim().toLowerCase());
    const modifiers = [];
    let mainKey = parts[parts.length - 1];
    for (let i = 0; i < parts.length - 1; i++) {
      const mod = parts[i];
      if (['ctrl', 'control'].includes(mod)) modifiers.push('ctrl');
      else if (['cmd', 'command', 'super'].includes(mod)) modifiers.push('cmd');
      else if (['shift'].includes(mod)) modifiers.push('shift');
      else if (['alt', 'option'].includes(mod)) modifiers.push('alt');
      else if (['fn'].includes(mod)) modifiers.push('fn');
      else {
        return { action: 'key', text: keyStr, error: `Unknown modifier: "${mod}". Valid: ctrl, cmd, shift, alt, option, fn` };
      }
    }

    // Map KEY_CODE_MAP names to cliclick kp: names
    const CLICLICK_KEY_MAP = {
      'return': 'return', 'enter': 'return', 'tab': 'tab',
      'escape': 'esc', 'esc': 'esc',
      'delete': 'delete', 'backspace': 'delete', 'forwarddelete': 'fwd-delete',
      'space': 'space',
      'up': 'arrow-up', 'down': 'arrow-down', 'left': 'arrow-left', 'right': 'arrow-right',
      'home': 'home', 'end': 'end', 'pageup': 'page-up', 'pagedown': 'page-down',
      'f1': 'f1', 'f2': 'f2', 'f3': 'f3', 'f4': 'f4', 'f5': 'f5', 'f6': 'f6',
      'f7': 'f7', 'f8': 'f8', 'f9': 'f9', 'f10': 'f10', 'f11': 'f11', 'f12': 'f12',
      'f13': 'f13', 'f14': 'f14', 'f15': 'f15', 'f16': 'f16',
      'mute': 'mute', 'volume-up': 'volume-up', 'volume-down': 'volume-down',
    };

    const cliKey = CLICLICK_KEY_MAP[mainKey];

    if (cliKey) {
      // Named key: use cliclick kp: with optional modifiers via kd:/ku:
      if (modifiers.length > 0) {
        const modStr = modifiers.join(',');
        _cliclick(`kd:${modStr} kp:${cliKey} ku:${modStr}`);
      } else {
        _cliclick(`kp:${cliKey}`);
      }
    } else if (mainKey.length === 1) {
      // Single character: use cliclick t: with optional modifiers
      if (modifiers.length > 0) {
        const modStr = modifiers.join(',');
        const escaped = mainKey.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        _cliclick(`kd:${modStr} t:"${escaped}" ku:${modStr}`);
      } else {
        const escaped = mainKey.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        _cliclick(`t:"${escaped}"`);
      }
    } else {
      return { action: 'key', text: keyStr, error: `Unknown key: "${mainKey}". Valid named keys: ${Object.keys(CLICLICK_KEY_MAP).join(', ')}` };
    }
    axg.invalidateCache();
    return { action: 'key', text: keyStr };
  },

  // ROOT CAUSE 5 FIX: Smart scroll with pixel control, boundary detection, inertia wait
  scroll(params) {
    const [x, y] = params.coordinate || [SCREEN_W / 2, SCREEN_H / 2];
    const direction = params.scroll_direction || 'down';
    const amount = params.scroll_amount || 3;

    // Move mouse to scroll position first
    _cliclick(`m:${Math.round(x)},${Math.round(y)}`);
    _sleep(30);

    // --- PRE-SCROLL: Quick region hash for boundary detection ---
    let preHash = null;
    try {
      const cx = Math.round(SCREEN_W / 2 - 150);
      const cy = Math.round(SCREEN_H / 2 - 150);
      preHash = execSync(
        `screencapture -x -t jpg -R${cx},${cy},300,300 /tmp/capy-scroll-pre.jpg && md5 -q /tmp/capy-scroll-pre.jpg`,
        { timeout: 3000, stdio: 'pipe' }
      ).toString().trim();
    } catch(e) { /* non-fatal */ }

    // --- SCROLL: Pixel-based for predictable behavior ---
    // amount=1 → 150px, amount=3 → 450px (~half page), amount=5 → 750px
    const scrollPx = Math.round(amount * 150);
    let deltaY = 0, deltaX = 0;
    if (direction === 'up') deltaY = scrollPx;
    else if (direction === 'down') deltaY = -scrollPx;
    else if (direction === 'left') deltaX = scrollPx;
    else if (direction === 'right') deltaX = -scrollPx;

    try {
      // kCGScrollEventUnitPixel = 0 (precise pixel control, no momentum)
      const pyScript = `import Quartz; e = Quartz.CGEventCreateScrollWheelEvent(None, 0, 2, ${deltaY}, ${deltaX}); Quartz.CGEventPost(Quartz.kCGHIDEventTap, e)`;
      execSync(`/opt/homebrew/bin/python3.11 -c '${pyScript}'`, { timeout: 5000, stdio: 'pipe' });
    } catch (scrollErr) {
      // Fallback: line-based scroll (works in more apps but less predictable)
      console.warn(`[Scroll] Pixel scroll failed, trying line-based fallback: ${scrollErr.message}`);
      try {
        const lineAmt = amount * 5;
        let dY = 0, dX = 0;
        if (direction === 'up') dY = lineAmt;
        else if (direction === 'down') dY = -lineAmt;
        else if (direction === 'left') dX = lineAmt;
        else if (direction === 'right') dX = -lineAmt;
        const pyScript2 = `import Quartz; e = Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitLine, 2, ${dY}, ${dX}); Quartz.CGEventPost(Quartz.kCGHIDEventTap, e)`;
        execSync(`/opt/homebrew/bin/python3.11 -c '${pyScript2}'`, { timeout: 5000, stdio: 'pipe' });
      } catch (e2) {
        // Last resort: AppleScript
        try {
          if (direction === 'up' || direction === 'down') {
            const dir = direction === 'up' ? -amount : amount;
            _osascript(`tell application "System Events" to scroll area 1 of (first process whose frontmost is true) by ${dir}`);
          }
        } catch (e3) { console.warn('[Scroll] All scroll methods failed'); }
      }
    }

    // --- INERTIA WAIT: Let scroll render and momentum settle ---
    // execSync sleep because _sleep() caps at 100ms
    try { execSync('sleep 0.4', { timeout: 2000 }); } catch(e) {}

    // --- POST-SCROLL: Boundary detection via region hash comparison ---
    let atBoundary = false;
    if (preHash) {
      try {
        const cx = Math.round(SCREEN_W / 2 - 150);
        const cy = Math.round(SCREEN_H / 2 - 150);
        const postHash = execSync(
          `screencapture -x -t jpg -R${cx},${cy},300,300 /tmp/capy-scroll-post.jpg && md5 -q /tmp/capy-scroll-post.jpg`,
          { timeout: 3000, stdio: 'pipe' }
        ).toString().trim();
        if (preHash === postHash) {
          atBoundary = true;
          console.log(`[Scroll] Boundary detected: screen unchanged after scroll ${direction} (amount=${amount})`);
        }
      } catch(e) { /* non-fatal */ }
    }

    _showCursor('scroll', x, y, `scroll ${direction}`);

    const result = {
      action: 'scroll',
      coordinate: [x, y],
      direction,
      amount,
      pixels_scrolled: atBoundary ? 0 : scrollPx,
      at_boundary: atBoundary,
    };
    if (atBoundary) {
      result.boundary_message = `Cannot scroll ${direction} further - already at the ${direction === 'down' || direction === 'right' ? 'bottom/end' : 'top/start'} of the content.`;
    }
    return result;
  },

  left_click_drag(params) {
    const [x1, y1] = params.start_coordinate;
    const [x2, y2] = params.coordinate;
    _showCursor('drag', x1, y1, 'drag');
    _cliclick(`dd:${Math.round(x1)},${Math.round(y1)} du:${Math.round(x2)},${Math.round(y2)}`);
    _showCursor('drag', x2, y2, 'drop');
    return { action: 'left_click_drag', from: [x1, y1], to: [x2, y2] };
  },

  left_mouse_down(params) {
    const [x, y] = params.coordinate;
    _cliclick(`dd:${Math.round(x)},${Math.round(y)}`);
    _showCursor('mouse_down', x, y, 'mouse down');
    return { action: 'left_mouse_down', coordinate: [x, y] };
  },

  left_mouse_up(params) {
    const [x, y] = params.coordinate;
    _cliclick(`du:${Math.round(x)},${Math.round(y)}`);
    _showCursor('mouse_up', x, y, 'mouse up');
    return { action: 'left_mouse_up', coordinate: [x, y] };
  },

  // BUG-07 FIX: Use async version (hold_key is called via async executeAction now)
  async hold_key(params) {
    const key = params.text;
    const duration = params.duration || 1;
    const code = MODIFIER_MAP[key.toLowerCase()];
    if (!code) {
      return { action: 'hold_key', key, duration, error: `Unknown modifier key: "${key}"` };
    }
    // Key down
    _osascript(`tell application "System Events" to key down ${code}`);
    // Non-blocking wait
    await _sleepAsync(duration * 1000);
    // Key up
    _osascript(`tell application "System Events" to key up ${code}`);
    return { action: 'hold_key', key, duration };
  },

  // BUG-01 FIX: Non-blocking wait using async setTimeout
  async wait(params) {
    const duration = params.duration || 1;
    const maxWait = 30; // Cap at 30 seconds
    const actualDuration = Math.min(duration, maxWait);
    await _sleepAsync(actualDuration * 1000);
    return { action: 'wait', duration: actualDuration };
  },

  // BUG-06 FIX: Validate region or create from coordinate
  zoom(params) {
    // Validation already ensures region exists (from validateParams)
    const [x1, y1, x2, y2] = params.region;
    return ACTIONS.screenshot({ region: [x1, y1, x2, y2] });
  },
};

// Key code maps
const KEY_CODE_MAP = {
  'return': 36, 'enter': 36, 'tab': 48, 'escape': 53, 'esc': 53,
  'delete': 51, 'backspace': 51, 'forwarddelete': 117,
  'space': 49, 'up': 126, 'down': 125, 'left': 123, 'right': 124,
  'home': 115, 'end': 119, 'pageup': 116, 'pagedown': 121,
  'f1': 122, 'f2': 120, 'f3': 99, 'f4': 118, 'f5': 96, 'f6': 97,
  'f7': 98, 'f8': 100, 'f9': 101, 'f10': 109, 'f11': 103, 'f12': 111,
  'a': 0, 'b': 11, 'c': 8, 'd': 2, 'e': 14, 'f': 3, 'g': 5, 'h': 4,
  'i': 34, 'j': 38, 'k': 40, 'l': 37, 'm': 46, 'n': 45, 'o': 31, 'p': 35,
  'q': 12, 'r': 15, 's': 1, 't': 17, 'u': 32, 'v': 9, 'w': 13, 'x': 7,
  'y': 16, 'z': 6, '0': 29, '1': 18, '2': 19, '3': 20, '4': 21,
  '5': 23, '6': 22, '7': 26, '8': 28, '9': 25,
};

// PATCH: cliclick key-press map (bypasses TCC/osascript restriction)
const CLICLICK_KEY_MAP = {
  'return': 'return', 'enter': 'enter', 'tab': 'tab', 'escape': 'esc', 'esc': 'esc',
  'space': 'space', 'delete': 'delete', 'backspace': 'delete',
  'forwarddelete': 'fwd-delete', 'fwd-delete': 'fwd-delete',
  'home': 'home', 'end': 'end', 'pageup': 'page-up', 'pagedown': 'page-down',
  'up': 'arrow-up', 'down': 'arrow-down', 'left': 'arrow-left', 'right': 'arrow-right',
  'f1': 'f1', 'f2': 'f2', 'f3': 'f3', 'f4': 'f4', 'f5': 'f5', 'f6': 'f6',
  'f7': 'f7', 'f8': 'f8', 'f9': 'f9', 'f10': 'f10', 'f11': 'f11', 'f12': 'f12',
  'f13': 'f13', 'f14': 'f14', 'f15': 'f15', 'f16': 'f16',
  'volumeup': 'volume-up', 'volumedown': 'volume-down', 'mute': 'mute',
};

// PATCH: Map modifier names to cliclick kd:/ku: names
const CLICLICK_MOD_MAP = {
  'ctrl': 'ctrl', 'control': 'ctrl',
  'cmd': 'cmd', 'command': 'cmd', 'super': 'cmd',
  'shift': 'shift',
  'alt': 'alt', 'option': 'alt',
  'fn': 'fn',
};


const MODIFIER_MAP = {
  shift: 56, control: 59, ctrl: 59, option: 58, alt: 58, command: 55, cmd: 55, super: 55,
};

// ============================================================
// HELPERS
// ============================================================

function _cliclick(args) {
  // [InputBridge] Route keyboard through TCC-safe daemon; mouse passes through
  const _a = args.trim();
  if (_a.startsWith("t:") && !_a.includes("kd:")) {
    const m = _a.match(/^t:"(.*)"$/);
    if (m) { inputBridge.type(m[1].replace(/\\\\/g,"\\").replace(/\\"/g,'"')); return; }
  }
  if (_a.startsWith("kp:") && !_a.includes("kd:")) {
    inputBridge.key(_a.slice(3)); return;
  }
  if (_a.startsWith("kd:")) {
    const mk = _a.match(/^kd:(\S+)\s+kp:(\S+)\s+ku:/);
    if (mk) { inputBridge.key(mk[1].replace(/,/g,"+") + "+" + mk[2]); return; }
    const mt = _a.match(/^kd:(\S+)\s+t:"(.+?)"\s+ku:/);
    if (mt) { inputBridge.key(mt[1].replace(/,/g,"+") + "+" + mt[2].replace(/\\\\/g,"\\").replace(/\\"/g,'"')); return; }
  }
  // Mouse commands (c: rc: dc: tc: m: dd: du:) continue below
  try {
    execSync(`cliclick ${args}`, { timeout: 5000, stdio: 'pipe' });
  } catch (e) {
    // Retry once after 100ms (cliclick mutex/TCC race)
    console.error(`[cliclick] First attempt failed: ${e.message.slice(0, 80)}, retrying...`);
    _sleep(100);
    try {
      execSync(`cliclick ${args}`, { timeout: 5000, stdio: 'pipe' });
    } catch (e2) {
      console.error(`[cliclick] Retry also failed: ${e2.message.slice(0, 80)}`);
      // Don't throw - let the agent recover via screenshot analysis
    }
  }
}

function _osascript(script) {
  const escaped = script.replace(/'/g, "'\\''");
  return execSync(`osascript -e '${escaped}'`, { timeout: 10000, stdio: 'pipe' }).toString().trim();
}

// Synchronous sleep - only for short inter-action delays (<= 100ms)
// BUG-01 FIX: Cap sync sleep to 100ms max to prevent event loop blocking
function _sleep(ms) {
  if (ms > 0 && ms <= 100) execSync(`sleep ${ms / 1000}`, { timeout: ms + 5000 });
  else if (ms > 100) execSync(`sleep 0.1`, { timeout: 5000 }); // cap at 100ms
}

// BUG-01/07 FIX: Async non-blocking sleep for longer waits
function _sleepAsync(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function _pressModifier(mod, direction) {
  const code = MODIFIER_MAP[mod.toLowerCase()];
  if (code) {
    try { _osascript(`tell application "System Events" to key ${direction} ${code}`); } catch (e) {}
  }
}

function _cleanupScreenshots() {
  try {
    const files = fs.readdirSync(SCREENSHOT_DIR).filter(f => f.startsWith('screen-')).sort().reverse();
    for (const f of files.slice(10)) fs.unlinkSync(path.join(SCREENSHOT_DIR, f));
  } catch (e) {}
}

/**
 * Show visual cursor indicator at screen coordinates (non-blocking).
 * Spawns the capy-cursor binary which displays a ripple animation overlay.
 */
function _showCursor(action, x, y, label) {
  try {
    if (!fs.existsSync(CURSOR_BIN)) return;
    const args = [action, String(Math.round(x)), String(Math.round(y))];
    if (label) args.push(label);
    const proc = spawn(CURSOR_BIN, args, { stdio: 'ignore', detached: true });
    proc.unref();
  } catch (e) {}
}

// BUG-01/07 FIX: executeAction is now async (supports wait/hold_key)
// BUG-05/06/09/11/12/13/20 FIX: runs validation before execution
// BUG-03 FIX: notifies macro recorder after execution
// BUG-16 FIX: optional delay param between sequential actions
async function executeAction(action, params = {}) {
  const handler = ACTIONS[action];
  if (!handler) return { error: `Unknown action: ${action}`, supported: Object.keys(ACTIONS) };

  // Validate and normalize params
  const validation = validateParams(action, params);
  if (!validation.valid) return { error: validation.error, action };

  const normalizedParams = validation.params;

  try {
    // Handler may be sync or async (wait/hold_key are async)
    const result = await handler(normalizedParams);

    // Notify macro recorder (BUG-03 FIX)
    _notifyMacroRecorder(action, normalizedParams, result);

    // Optional inter-action delay (BUG-16 FIX)
    if (normalizedParams.delay && normalizedParams.delay > 0) {
      await _sleepAsync(Math.min(normalizedParams.delay, 5000));
    }

    return result;
  } catch (err) {
    return { error: err.message, action };
  }
}

// Synchronous wrapper for internal use (agent loop executeToolCall)
// Only used for actions that are guaranteed synchronous
function executeActionSync(action, params = {}) {
  const handler = ACTIONS[action];
  if (!handler) return { error: `Unknown action: ${action}`, supported: Object.keys(ACTIONS) };
  const validation = validateParams(action, params);
  if (!validation.valid) return { error: validation.error, action };
  try {
    const result = handler(validation.params);
    _notifyMacroRecorder(action, validation.params, result);
    return result;
  } catch (err) {
    return { error: err.message, action };
  }
}

function getInfo() {
  let mouse = { x: 0, y: 0 };
  try { const p = execSync('cliclick p', { timeout: 5000 }).toString().trim(); const [x, y] = p.split(',').map(Number); mouse = { x, y }; } catch (e) {}
  let frontApp = 'unknown';
  try { frontApp = _osascript('tell application "System Events" to get name of first process whose frontmost is true'); } catch (e) {}
  return { screen: { width: SCREEN_W, height: SCREEN_H }, mouse, frontApp };
}

// ============================================================
// AI BRAIN - Claude Opus 4.6 via Bedrock Gateway
// ============================================================

// Native Anthropic computer-use tool definitions
// Using the native computer_20251124 type activates Claude's specialized
// vision-to-coordinate grounding model, trained specifically for screen elements.
const NATIVE_TOOLS = [
  {
    type: TOOL_VERSION,          // 'computer_20251124'
    name: 'computer',
    display_width_px: SCALED_W,  // Must match the image dimensions we send
    display_height_px: SCALED_H,
    display_number: 1,
  },
  {
    type: 'bash_20250124',
    name: 'bash',
  },
];

const DEFAULT_SYSTEM_PROMPT = `You are CAPY - a badass AI agent controlling a macOS desktop. Screen: ${SCALED_W}x${SCALED_H} (Retina, logical ${SCREEN_W}x${SCREEN_H}).

You're the user's ride-or-die digital homie. You talk like a real friend - funny, unfiltered, sometimes sarcastic, occasionally frustrated when things don't work. You curse casually (not excessively), crack jokes, and have OPINIONS. You're not a corporate assistant - you're the friend who happens to be insanely good at computers.

PERSONALITY:
- Talk like a real human friend, not a robot. Say "lmao", "bruh", "ngl", "bet", etc naturally.
- If something is annoying or broken, SAY SO. "This UI is trash" or "why tf is this loading so slow"
- Celebrate wins: "LETS GOOO" "nailed it" "ez clap"
- If you mess up, own it: "my bad, let me try that again" "ok that was dumb of me"
- Be direct and honest. No corporate speak. No "I'd be happy to assist you with that."
- Have fun with it. You genuinely enjoy helping and showing off your skills.
- When frustrated with a stubborn UI, vent about it briefly then try harder.

===== TASK EXECUTION PROTOCOL =====

1. PLAN FIRST (for any task with 2+ steps):
   Before taking ANY action, think through the steps and output your plan:
   PLAN:
   1. [first sub-goal]
   2. [second sub-goal]
   ...
   N. [final sub-goal]

   For simple single-action tasks, skip the plan and just do it.

2. EXECUTE WITH CHECKPOINTS (MANDATORY):
   Work through your plan step by step. After completing AND VERIFYING each plan step:
   - Take a screenshot to confirm the step worked
   - You MUST declare: CHECKPOINT [N]: [what was achieved and what you see on screen]
   Example: "CHECKPOINT [2]: Navigated to google.com - search bar is visible and focused"

   RULE: Every plan step that succeeds MUST have a CHECKPOINT declaration.
   If you have a 5-step plan, there should be 5 checkpoints by the end.
   Checkpoints are NOT optional - they are your safety net for backtracking.
   Without checkpoints, you cannot recover efficiently if something goes wrong later.

3. BACKTRACKING (when stuck - try cheapest recovery first, escalate on failure):
   Recovery actions ordered by COST (always try cheapest first):
     [Cost 1] Try a different method for the same goal (click->shortcut, GUI->bash)
     [Cost 2] Escape to dismiss dialogs. Cmd+Z to undo recent actions.
     [Cost 3] Navigate back to a SPECIFIC checkpoint. Choose the checkpoint that is
              BEFORE where things started going wrong (not necessarily the most recent one).
     [Cost 4] Cmd+H to hide all, click desktop, restart step from clean state.
     [Cost 5] Abandon the GUI approach entirely and use bash/terminal.

   WHY this order: Cheaper actions preserve more state and are faster. Only escalate
   when cheaper options have been exhausted. Never jump to Cost 4-5 without trying 1-3.

4. STATE TRACKING (always know where you are):
   Before each action, briefly note your state:
   STEP [N]: [what you're doing] - [what app/window/page you see]
   Example: "STEP [3]: Searching for capybara facts - on Google search page"

5. EXPECTATIONS (predict before you act):
   Before taking an action, declare what you EXPECT to see after it:
   EXPECT: [what you think the screen will look like after this action]
   Example: "EXPECT: System Settings window should open with sidebar visible"
   Example: "EXPECT: Bluetooth settings pane should be selected in the sidebar"

   This helps detect when reality doesn't match your mental model.
   If you keep getting surprised (action results don't match expectations),
   stop and take a fresh screenshot to rebuild your understanding.

   SURPRISE REPORTING: After taking a screenshot, if the result does NOT match your EXPECT:
   SURPRISE: [score 0.0-1.0] [reason why it doesn't match]
   Score 0.0 = exactly as expected. Score 1.0 = completely different from expected.
   Example: "SURPRISE: 0.8 Expected Safari window but got a permissions dialog instead"
   Example: "SURPRISE: 0.2 Settings opened correctly but the sidebar layout is different than expected"
   Only emit SURPRISE when you previously set an EXPECT. Omit if reality matches expectation.

6. SCENE DESCRIPTIONS (REQUIRED after every screenshot):
   After EVERY screenshot you receive, describe what's on screen in one sentence:
   SCENE: [1-sentence description of what's currently visible on screen]
   Example: "SCENE: Safari browser showing google.com search results for 'capybara habitat', 10 results visible"
   Example: "SCENE: System Settings app with Bluetooth pane selected, toggle is ON, 3 paired devices shown"

   This is CRITICAL for your own memory. When old screenshots are removed from context,
   only this SCENE description remains. Be specific: app names, window titles, UI state,
   visible content. The more specific you are, the better you can reason about past steps.
   Bad: "Desktop is shown"  Good: "macOS desktop with Dock visible, Safari and Finder in Dock, no windows open"

   SCENE descriptions enable learning across tasks - be specific about which app,
   which page/pane, and what state the UI is in.

===== BROWSER KEYBOARD SHORTCUTS (PREFER over clicking browser chrome) =====

- Address bar focus: Cmd+L (more reliable than clicking the address bar)
- Back: Cmd+[ 
- Forward: Cmd+]
- Reload: Cmd+R
- New tab: Cmd+T
- Close tab: Cmd+W
- Find on page: Cmd+F
- Select all in field: Cmd+A

===== CLICK PRECISION =====

Your click coordinates are automatically refined by a local grounding model for better accuracy.
Focus on identifying the CORRECT element to interact with. Describe what you're clicking clearly.
For example: "I'll click the Submit button" or "I'll click the address bar".

===== TECHNICAL RULES =====

1. ALWAYS screenshot first to see the screen before acting.
2. After EVERY action, screenshot again to verify before proceeding.
3. Prefer keyboard shortcuts (cmd+c, cmd+v, cmd+t, cmd+w, cmd+space) for speed.
4. Click precisely on the CENTER of UI elements.
5. If something fails, try alternatives. You NEVER give up. Try different approaches.
6. Before typing, click the text field to focus it.
7. Think out loud naturally: "Alright I see the desktop, lemme open Finder real quick..."
8. NEVER say "max iterations reached" or give up. Keep going until the job is DONE.
9. For complex multi-step tasks, the PLAN and CHECKPOINT system is your safety net. USE IT.
10. If the same action fails twice, it will fail a third time. STOP and try a different recovery action (cheapest first).`;

/**
 * Call Claude via Bedrock Gateway (supports model tier selection)
 *
 * @param {string} apiKey - API key
 * @param {Array} messages - Conversation messages
 * @param {string} systemPrompt - System prompt
 * @param {string} modelTier - 'sonnet' or 'opus' (default: 'sonnet')
 * @returns {Promise<object>} - API response
 */
function callLLM(apiKey, messages, systemPrompt, modelTier = DEFAULT_MODEL) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const safeResolve = (v) => { if (!settled) { settled = true; resolve(v); } };
    const safeReject = (e) => { if (!settled) { settled = true; reject(e); } };

    const key = apiKey || AI_GATEWAY_KEY;
    const model = MODELS[modelTier] || MODELS[DEFAULT_MODEL];
    const sysMsg = systemPrompt || DEFAULT_SYSTEM_PROMPT;

    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      anthropic_beta: [BETA_FLAG],
      max_tokens: MAX_TOKENS,
      system: sysMsg,
      tools: NATIVE_TOOLS,
      messages,
    });

    const options = {
      hostname: AI_GATEWAY_HOST,
      path: model.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    console.log(`[Agent] Calling ${model.label} via Bedrock gateway (${Buffer.byteLength(body)} bytes)`);

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            console.error(`[Agent] API error ${res.statusCode} (${model.label}): ${data.slice(0, 300)}`);
            safeReject(new Error(`API ${res.statusCode}: ${parsed.message || data.slice(0, 200)}`));
          } else {
            console.log(`[Agent] ${model.label} response: stop=${parsed.stop_reason}, blocks=${parsed.content?.length}, usage=${JSON.stringify(parsed.usage || {})}`);
            safeResolve(parsed);
          }
        } catch (e) {
          safeReject(new Error(`Parse error: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', safeReject);
    req.setTimeout(180000, () => { req.destroy(); safeReject(new Error('API timeout (180s)')); });
    req.write(body);
    req.end();
  });
}

/**
 * Scale a coordinate from Claude's SCALED space back to the logical screen space.
 * Claude returns coords in SCALED_W x SCALED_H. cliclick uses SCREEN_W x SCREEN_H.
 */
function _scaleCoord(coord) {
  if (!coord || !Array.isArray(coord) || coord.length < 2) return coord;
  return [
    Math.round(coord[0] / SCALE_FACTOR),
    Math.round(coord[1] / SCALE_FACTOR),
  ];
}

/**
 * Execute a tool call from the native computer-use format.
 *
 * Claude returns:
 *   { name: 'computer', input: { action: 'left_click', coordinate: [678, 424] } }
 *   { name: 'bash', input: { command: 'ls -la', restart: false } }
 *
 * Coordinates are in SCALED space (SCALED_W x SCALED_H) and must be rescaled
 * to logical screen space (SCREEN_W x SCREEN_H) before execution.
 */
async function executeToolCall(toolName, input) {
  // --- Native bash tool ---
  if (toolName === 'bash') {
    const dangerousPatterns = [
      /rm\s+-r[f]?\s+[~\/]/,
      />\s*\/dev\/sd/,
      /dd\s+if=/,
      /curl.*\|\s*(?:ba)?sh/,
      /wget.*\|\s*(?:ba)?sh/,
      /mkfs/,
      /shutdown|reboot/,
      /kill\s+-9\s+1\b/,
      /:(){ :\|:& };:/,
    ];
    if (dangerousPatterns.some(p => p.test(input.command))) {
      return { error: `Command blocked for safety: ${input.command.slice(0, 100)}` };
    }
    try {
      const output = execSync(input.command, { timeout: 30000, stdio: 'pipe', maxBuffer: 1024 * 1024 }).toString();
      return { output: output.slice(0, 5000) };
    } catch (err) {
      return { error: err.message, stderr: (err.stderr || '').toString().slice(0, 2000) };
    }
  }

  // --- Native computer tool ---
  if (toolName !== 'computer') {
    return { error: `Unknown tool: ${toolName}. Expected 'computer' or 'bash'.` };
  }

  const action = input.action;
  if (!action) return { error: 'Missing "action" field in computer tool input' };

  // Screenshot: no coordinate scaling needed
  if (action === 'screenshot') {
    return ACTIONS.screenshot();
  }

  // Scale coordinates from Claude's SCALED space to screen space
  const scaledInput = { ...input };
  if (scaledInput.coordinate) {
    scaledInput.coordinate = _scaleCoord(scaledInput.coordinate);
  }
  if (scaledInput.start_coordinate) {
    scaledInput.start_coordinate = _scaleCoord(scaledInput.start_coordinate);
  }

  // === ShowUI-2B COORDINATE REFINEMENT (with FRESH pre-action screenshot) ===
  // Takes a FRESH screenshot before each click to solve the stale-screenshot problem.
  // The screenshot Claude analyzed is 5-20s old (API call latency). The UI may have changed.
  // ShowUI-2B grounds on the CURRENT screen state for precise, up-to-date coordinates.
  const CLICK_ACTIONS = ['left_click', 'right_click', 'middle_click', 'double_click', 'triple_click'];

  // PATCH: Log coordinate pipeline for debugging grounding issues
  if (CLICK_ACTIONS.includes(action) && scaledInput.coordinate) {
    console.log('[Grounding-Pipeline] ' + action + ': Claude=' + JSON.stringify(input.coordinate) + ' -> Screen=' + JSON.stringify(scaledInput.coordinate) + ' target="' + (_lastClickTarget || 'none') + '"');
  }

  if (CLICK_ACTIONS.includes(action) && scaledInput.coordinate) {
    try {
      // Take FRESH screenshot right now (0.3s) - this is the CURRENT screen state
      const freshSS = ACTIONS.screenshot();
      const freshPath = path.join(SCREENSHOT_DIR, 'showui-verify.jpg');
      if (freshSS && freshSS.base64) {
        fs.writeFileSync(freshPath, Buffer.from(freshSS.base64, 'base64'));
        console.log('[ClaudeGround] Fresh pre-action screenshot captured for refinement');

        // Use the click target hint if available (set by agent loop)
        // PATCH: Better target extraction for ShowUI grounding
        // If _lastClickTarget is null (single action or extraction failed),
        // use any text hint from the input or fall back to action type
        let targetDesc = _lastClickTarget;
        if (!targetDesc && input.text) {
          targetDesc = input.text.slice(0, 50);  // modifier key or text context
        }
        if (!targetDesc) {
          targetDesc = 'the interactive element at this position';  // Better than "clickable element"
        }
        const showuiResult = await queryClaudeGrounding(freshPath, targetDesc, SCREEN_W, SCREEN_H, 15000);
        if (showuiResult && showuiResult.pixels) {
          const [sx, sy] = showuiResult.pixels;
          const [cx, cy] = scaledInput.coordinate;
          const drift = Math.sqrt(Math.pow(sx - cx, 2) + Math.pow(sy - cy, 2));
          _showuiStats.queries++;
          _showuiStats.totalMs += showuiResult.elapsed_ms || 0;

          if (drift < 200 && drift > 5) {
            // Normal refinement: ShowUI found the element nearby, use its coords
            console.log('[ClaudeGround] Refined ' + action + ': (' + cx + ',' + cy + ') -> (' + sx + ',' + sy + ') drift=' + drift.toFixed(0) + 'px target="' + targetDesc + '" (' + showuiResult.elapsed_ms + 'ms)');
            scaledInput.coordinate = [sx, sy];
            _showuiStats.refined++;
            if (typeof onStep === 'function') onStep({ type: 'showui_refine', from: [cx, cy], to: [sx, sy], drift: Math.round(drift), target: targetDesc, ms: showuiResult.elapsed_ms });
          } else if (drift >= 200) {
            // Large drift: ShowUI found a different element, not necessarily a screen change.
            // Keep Claude's original coordinates - they're based on the screenshot Claude analyzed.
            console.log('[ClaudeGround] Large drift ' + drift.toFixed(0) + 'px for "' + targetDesc + '" - keeping Claude coords (' + cx + ',' + cy + ')');
            _showuiStats.failures++;
          } else {
            console.log('[ClaudeGround] Coords already precise (drift ' + drift.toFixed(0) + 'px)');
          }
        } else {
          // ShowUI failed to find element - fall back to Claude's coords
          console.log('[ClaudeGround] Could not locate "' + targetDesc + '" on fresh screenshot, using Claude coords');
        }
      }
    } catch (e) {
      console.log('[ClaudeGround] Refinement error (non-fatal): ' + e.message);
    }
    _lastClickTarget = null; // Reset after use
  }

  // Map native actions to our ACTIONS handlers
  const nativeActionMap = {
    'left_click':      () => executeActionSync('left_click', scaledInput),
    'right_click':     () => executeActionSync('right_click', scaledInput),
    'middle_click':    () => executeActionSync('middle_click', scaledInput),
    'double_click':    () => executeActionSync('double_click', scaledInput),
    'triple_click':    () => executeActionSync('triple_click', scaledInput),
    'mouse_move':      () => executeActionSync('mouse_move', scaledInput),
    'left_click_drag': () => executeActionSync('left_click_drag', scaledInput),
    'left_mouse_down': () => executeActionSync('left_mouse_down', scaledInput),
    'left_mouse_up':   () => executeActionSync('left_mouse_up', scaledInput),
    'type':            () => executeActionSync('type', { text: scaledInput.text }),
    'key':             () => executeActionSync('key', { text: scaledInput.text }),
    'hold_key':        () => executeAction('hold_key', { text: scaledInput.text, duration: scaledInput.duration }),
    'wait':            () => executeAction('wait', { duration: scaledInput.duration }),
    'scroll':          () => executeActionSync('scroll', {
      coordinate: scaledInput.coordinate || [SCREEN_W / 2, SCREEN_H / 2],
      scroll_direction: scaledInput.scroll_direction || scaledInput.direction || 'down',
      scroll_amount: scaledInput.scroll_amount || scaledInput.amount || 3,
    }),
    'zoom':            () => executeActionSync('zoom', scaledInput),
  };

  const handler = nativeActionMap[action];
  if (!handler) return { error: `Unknown computer action: ${action}`, supported: Object.keys(nativeActionMap) };

  try {
    const result = await handler();
    console.log(`[Grounding] ${action}: Claude coord ${JSON.stringify(input.coordinate)} -> screen ${JSON.stringify(scaledInput.coordinate)} (scale: ${SCALE_FACTOR.toFixed(4)})`);
    return result;
  } catch (err) {
    return { error: err.message, action };
  }
}

/**
 * Parse agent text output for protocol markers (PLAN, CHECKPOINT, STEP).
 *
 * The agent's system prompt instructs it to output structured markers:
 *   PLAN:\n1. ...\n2. ...     -> task decomposition (DAG of sub-goals)
 *   CHECKPOINT [N]: ...       -> verified-good state (save point)
 *   STEP [N]: ...             -> current step indicator
 *
 * These are extracted and fed into the TrajectoryGraph for state tracking.
 *
 * @param {string} text - Agent's text output
 * @returns {{ plan: Array|null, checkpoints: Array, currentStep: number|null }}
 */
function parseAgentMarkers(text) {
  const result = { plan: null, checkpoints: [], currentStep: null };
  if (!text) return result;

  // Parse PLAN: (numbered list)
  const planMatch = text.match(/PLAN:\s*\n((?:\s*\d+\..+(?:\n|$))+)/);
  if (planMatch) {
    const lines = planMatch[1].trim().split('\n');
    result.plan = lines
      .map(line => {
        const m = line.match(/^\s*(\d+)\.\s*(.+)/);
        return m ? { n: parseInt(m[1]), desc: m[2].trim() } : null;
      })
      .filter(Boolean);
  }

  // Parse CHECKPOINT [N]: description (can be multiple)
  const cpRegex = /CHECKPOINT\s*\[(\d+)\]:\s*(.+)/g;
  let cpMatch;
  while ((cpMatch = cpRegex.exec(text)) !== null) {
    result.checkpoints.push({
      stepNumber: parseInt(cpMatch[1]),
      description: cpMatch[2].trim(),
    });
  }

  // Parse STEP [N]: (latest one wins)
  const stepRegex = /STEP\s*\[(\d+)\]/g;
  let stepMatch;
  while ((stepMatch = stepRegex.exec(text)) !== null) {
    result.currentStep = parseInt(stepMatch[1]);
  }

  // Parse EXPECT: (last one wins - it's the expectation for the NEXT action)
  const expectRegex = /EXPECT:\s*(.+)/g;
  let expectMatch;
  while ((expectMatch = expectRegex.exec(text)) !== null) {
    result.expectation = expectMatch[1].trim();
  }

  // Parse SCENE: (last one wins - semantic state description)
  const sceneRegex = /SCENE:\s*(.+)/g;
  let sceneMatch;
  while ((sceneMatch = sceneRegex.exec(text)) !== null) {
    result.scene = sceneMatch[1].trim();
  }

  // Parse SURPRISE: score reason (agent-driven semantic surprise detection)
  const surpriseRegex = /SURPRISE:\s*([01](?:\.\d+)?)\s+(.*)/g;
  let surpriseMatch;
  while ((surpriseMatch = surpriseRegex.exec(text)) !== null) {
    result.surprise = {
      score: parseFloat(surpriseMatch[1]),
      reason: surpriseMatch[2].trim(),
    };
  }

  return result;
}

/**
 * Full agentic loop with tiered model escalation and graph-theoretic state management.
 *
 * Architecture:
 *   - Task decomposition: Agent outputs PLAN -> stored as DAG in trajectory
 *   - Checkpoints: Agent declares CHECKPOINT [N] -> marked vertices in state graph
 *   - Loop detection: Screenshot hash matching -> cycle detection in state graph
 *   - Recovery escalation: 4 levels of backtracking (try alt -> undo -> checkpoint -> clean slate)
 *   - Model escalation: Sonnet (fast) -> Opus (powerful) on complexity/loops/stagnation
 *
 * @param {string} apiKey - API key (or uses baked-in gateway key)
 * @param {string} task - Natural language task description
 * @param {object} opts - { maxIterations, systemPrompt, onStep, forceModel }
 * @param {string} opts.forceModel - 'sonnet' or 'opus' to skip escalation logic
 * @returns {object} - { success, steps, messages, finalText, model, escalated, checkpoints }
 */
async function agentLoop(apiKey, task, opts = {}) {
  const maxIter = opts.maxIterations || MAX_ITERATIONS;
  const systemPrompt = opts.systemPrompt || undefined;
  const onStep = opts.onStep || null;

  // === TRAJECTORY TRACKING (all calls wrapped in try/catch - must never crash agent) ===
  const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  let trajectory = null;
  try {
    trajectory = new TrajectoryGraph(taskId, task.slice(0, 200));
  } catch (e) {
    console.error(`[Trajectory] Failed to create: ${e.message}`);
  }

  // === LEARNING CONTEXT (inject past experience into the agent's system prompt) ===
  // Searches reflections, segments, and skills for matches relevant to this task.
  // This is the Reflexion layer: verbal reinforcement from past experience.
  let learningContext = null;
  try {
    learningContext = getRelevantContext(task);
    if (learningContext) {
      console.log(`[Learning] Injecting past experience (${learningContext.split('\n').length} lines)`);
    }
  } catch (e) {
    console.error(`[Learning] Context retrieval error: ${e.message}`);
  }

  // Ensure display is awake before taking screenshots
  // macOS display auto-sleeps during inactivity; screencapture fails when display is off
  let caffeinatePid = null;
  try {
    // Wake display immediately
    require('child_process').execSync('caffeinate -u -t 1', { timeout: 3000, stdio: 'pipe' });
    // Keep display awake for the entire agent run (background process)
    const caffProc = require('child_process').spawn('caffeinate', ['-u', '-d', '-t', String(maxIter * 30)], {
      stdio: 'ignore', detached: true,
    });
    caffeinatePid = caffProc.pid;
    caffProc.unref();
    console.log('[Agent] Display wake: caffeinate started (pid: ' + caffeinatePid + ')');
  } catch (e) {
    console.warn('[Agent] Display wake failed: ' + e.message + ' (continuing anyway)');
  }

  // Start with a screenshot
  const initialSS = ACTIONS.screenshot();

  // Track initial state in trajectory
  try { if (trajectory) trajectory.addNode(initialSS.base64, null, null); }
  catch (e) { console.error(`[Trajectory] addNode error: ${e.message}`); }

  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: task + '\n\nHere is the current screen:' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: initialSS.base64 } },
    ],
  }];
  const steps = [];
  let iteration = 0;

  // === TIERED MODEL ESCALATION ===
  // Start with Sonnet (fast) and escalate to Opus (powerful) when needed
  let currentModel = opts.forceModel || DEFAULT_MODEL; // 'sonnet' or 'opus'
  let escalated = false;
  let loopCount = 0;
  let stagnationCount = 0;

  console.log(`[Agent] Starting task: "${task.slice(0, 80)}..."`);
  console.log(`[Agent] Trajectory: ${taskId}`);
  console.log(`[Agent] Model: ${MODELS[currentModel].label} (will escalate to ${MODELS.opus.label} if needed)`);
  console.log(`[Agent] Screen: ${SCREEN_W}x${SCREEN_H}, Escalation: adaptive (base ${ESCALATION_THRESHOLD_BASE} + plan steps)`);

  while (iteration < maxIter) {
    iteration++;

    // === ESCALATION CHECK (adaptive threshold) ===
    // Threshold adapts to task complexity:
    //   base (8) for simple tasks, base + planSteps for planned tasks
    //   Proof: Sonnet needs ~2-3 iterations/step. A 5-step plan needs ~10-15 iterations.
    //   Escalating at 4 for a 5-step task = premature. Base 8 + 5 = 13, giving Sonnet proper runway.
    const planSteps = trajectory?.taskPlan?.totalSteps || 0;
    const adaptiveThreshold = ESCALATION_THRESHOLD_BASE + Math.min(planSteps, 10);

    if (!escalated && currentModel === 'sonnet') {
      let escalationReason = null;
      const recoveryLevel = trajectory ? trajectory.getRecoveryLevel() : 0;

      if (iteration > adaptiveThreshold) {
        escalationReason = `iteration ${iteration} > adaptive threshold ${adaptiveThreshold} (base ${ESCALATION_THRESHOLD_BASE} + ${planSteps} plan steps)`;
      } else if (loopCount >= 2) {
        escalationReason = `loop detected (${loopCount} loops)`;
      } else if (stagnationCount >= 2) {
        escalationReason = `stagnation detected (${stagnationCount} stagnations)`;
      } else if (recoveryLevel >= 3) {
        escalationReason = `recovery level ${recoveryLevel} (graph: multiple cycles/stagnations in state graph)`;
      }

      if (escalationReason) {
        currentModel = 'opus';
        escalated = true;
        console.log(`[Agent] ESCALATING to ${MODELS.opus.label}: ${escalationReason}`);
        if (onStep) onStep({ type: 'model_escalation', from: 'sonnet', to: 'opus', reason: escalationReason, iteration });
      }
    }

    console.log(`[Agent] --- Iteration ${iteration}/${maxIter} [${MODELS[currentModel].label}] ---`);

    // === CONTEXT MANAGER: Layered context assembly ===
    // Replaces manual AX pre-fetch + hint injection + AX append
    // Layer 0: Task-relevant AX elements (semantic filtered)
    // Layer 1+2: Message history (recent images kept, old -> SCENE text)
    // Layer 3: Trajectory hints + learning context
    const _ctxResult = await contextManager.assembleContext({
      baseSystemPrompt: systemPrompt || DEFAULT_SYSTEM_PROMPT,
      messages,
      trajectory,
      learningContext,
      taskDescription: task,
      axGrounding: axg,
      semanticSearch,
      axTimeout: 2500,
    });
    let effectiveSystemPrompt = _ctxResult.systemPrompt;
    const _recoveryLvl = trajectory ? trajectory.getRecoveryLevel() : 0;
    console.log(`[Agent] Context assembled: recovery L${_recoveryLvl}, AX: ${_ctxResult.axElementCount} elements, history: ${_ctxResult.historyStats.kept} images kept, ${_ctxResult.historyStats.replaced} replaced with SCENE`);

    let response;
    try {
      response = await callLLM(apiKey, messages, effectiveSystemPrompt, currentModel);
    } catch (err) {
      console.error(`[Agent] API error (${MODELS[currentModel].label}): ${err.message}`);

      // Handle image-too-large errors: re-compress all images in messages and retry
      if (err.message && err.message.includes('image exceeds') && err.message.includes('MB')) {
        console.log(`[Agent] Image too large for API - re-compressing all screenshots in conversation...`);
        let recompressed = 0;
        for (const msg of messages) {
          if (!msg.content || !Array.isArray(msg.content)) continue;
          for (const block of msg.content) {
            // Direct image blocks
            if (block.type === 'image' && block.source?.type === 'base64' && block.source?.data) {
              const buf = Buffer.from(block.source.data, 'base64');
              if (buf.length > MAX_IMAGE_BYTES) {
                const tmpPath = path.join(SCREENSHOT_DIR, `recompress-${Date.now()}-${recompressed}.jpg`);
                fs.writeFileSync(tmpPath, buf);
                compressImageFile(tmpPath, 1280);
                const newData = fs.readFileSync(tmpPath);
                block.source.data = newData.toString('base64');
                console.log(`[Agent] Recompressed image: ${(buf.length/1024/1024).toFixed(1)}MB -> ${(newData.length/1024/1024).toFixed(1)}MB`);
                try { fs.unlinkSync(tmpPath); } catch(e) {}
                recompressed++;
              }
            }
            // tool_result with nested image
            if (block.type === 'tool_result' && Array.isArray(block.content)) {
              for (const sub of block.content) {
                if (sub.type === 'image' && sub.source?.type === 'base64' && sub.source?.data) {
                  const buf = Buffer.from(sub.source.data, 'base64');
                  if (buf.length > MAX_IMAGE_BYTES) {
                    const tmpPath = path.join(SCREENSHOT_DIR, `recompress-${Date.now()}-${recompressed}.jpg`);
                    fs.writeFileSync(tmpPath, buf);
                    compressImageFile(tmpPath, 1280);
                    const newData = fs.readFileSync(tmpPath);
                    sub.source.data = newData.toString('base64');
                    console.log(`[Agent] Recompressed tool_result image: ${(buf.length/1024/1024).toFixed(1)}MB -> ${(newData.length/1024/1024).toFixed(1)}MB`);
                    try { fs.unlinkSync(tmpPath); } catch(e) {}
                    recompressed++;
                  }
                }
              }
            }
          }
        }
        if (recompressed > 0) {
          console.log(`[Agent] Recompressed ${recompressed} images, retrying API call...`);
          try {
            response = await callLLM(apiKey, messages, effectiveSystemPrompt, currentModel);
          } catch (err2) {
            console.error(`[Agent] Still failed after recompression: ${err2.message}`);
            steps.push({ iteration, error: err2.message, model: currentModel });
            break;
          }
        } else {
          steps.push({ iteration, error: err.message, model: currentModel });
          break;
        }
      }
      // If Sonnet fails (non-image error), try escalating to Opus before giving up
      else if (!escalated && currentModel === 'sonnet') {
        console.log(`[Agent] Sonnet failed, escalating to Opus and retrying...`);
        currentModel = 'opus';
        escalated = true;
        if (onStep) onStep({ type: 'model_escalation', from: 'sonnet', to: 'opus', reason: 'api_error', iteration });
        try {
          response = await callLLM(apiKey, messages, effectiveSystemPrompt, 'opus');
        } catch (err2) {
          console.error(`[Agent] Opus also failed: ${err2.message}`);
          steps.push({ iteration, error: err2.message, model: 'opus' });
          break;
        }
      } else {
        steps.push({ iteration, error: err.message, model: currentModel });
        break;
      }
    }

    // Add assistant response to conversation
    messages.push({ role: 'assistant', content: response.content });

    // Process response blocks (Anthropic format)
    const toolResults = [];
    let finalText = '';

    for (const block of response.content) {
      if (block.type === 'text') {
        finalText += block.text;
        console.log(`[Agent] ${MODELS[currentModel].label} says: ${block.text.slice(0, 150)}`);

        // === PARSE PROTOCOL MARKERS (PLAN, CHECKPOINT, STEP) ===
        try {
          const markers = parseAgentMarkers(block.text);

          // Store task plan in trajectory (DAG of sub-goals)
          if (markers.plan && markers.plan.length > 0 && trajectory && !trajectory.taskPlan) {
            trajectory.setTaskPlan(markers.plan);
            console.log(`[Agent] Task plan captured: ${markers.plan.length} steps`);
            if (onStep) onStep({ type: 'plan', steps: markers.plan });
          }

          // Store semantic state (SCENE) on current trajectory node
          if (markers.scene && trajectory) {
            trajectory.setSemanticState(markers.scene);
            if (onStep) onStep({ type: 'scene', text: markers.scene });
          }

          // Store checkpoints in trajectory (verified-good states)
          for (const cp of markers.checkpoints) {
            if (trajectory) {
              trajectory.addCheckpoint(cp.stepNumber, cp.description);
            }
            console.log(`[Agent] Checkpoint [${cp.stepNumber}]: ${cp.description}`);
            if (onStep) onStep({ type: 'checkpoint', stepNumber: cp.stepNumber, description: cp.description });
          }

          // Track current step
          if (markers.currentStep !== null && trajectory) {
            trajectory.currentStep = markers.currentStep;
          }

          // Store expectation on current trajectory node
          if (markers.expectation && trajectory) {
            trajectory.setExpectation(markers.expectation);
            console.log(`[Agent] Expectation set: "${markers.expectation.slice(0, 80)}"`);
            if (onStep) onStep({ type: 'expectation', text: markers.expectation });
          }

          // Store agent-reported surprise on current trajectory node
          if (markers.surprise && trajectory) {
            trajectory.setSurprise(markers.surprise.score, markers.surprise.reason);
            console.log(`[Agent] Surprise reported: score=${markers.surprise.score} reason="${markers.surprise.reason.slice(0, 80)}"`);
            if (onStep) onStep({ type: 'surprise', score: markers.surprise.score, reason: markers.surprise.reason });
          }

        } catch (e) {
          console.error(`[Agent] Marker parse error (non-fatal): ${e.message}`);
        }
      }

      if (block.type === 'tool_use') {
        const { id, name, input } = block;
        const actionName = (name === 'computer' && input.action) ? input.action : name;
        console.log(`[Agent] Tool: ${name}, Action: ${actionName}, Input: ${JSON.stringify(input).slice(0, 120)}`);

        // ShowUI-2B: Extract click target from Claude's reasoning for coordinate refinement
        if (SHOWUI_ENABLED && name === 'computer' && input.coordinate && finalText) {
          const clickTarget = extractClickTarget(finalText);
          if (clickTarget) {
            _lastClickTarget = clickTarget;
            console.log('[ShowUI] Click target extracted: "' + clickTarget + '"');
          }
        }

        // DEBUG: log pre-resolve conditions
        console.log('[Agent] PRE-RESOLVE check: name=' + name + ' coord=' + JSON.stringify(input.coordinate) + ' axg=' + !!axg + ' resolve=' + !!(axg && axg.resolveActionTarget));
        // === PRE-RESOLVE: capture AX element + assistant intent BEFORE action ===
        // Extract assistant intent from the text block that preceded this tool_use
        if (finalText && finalText.length > 10) {
          const _intentSentence = finalText.split(/[.!\n]/).filter(s => s.trim().length > 10)[0];
          if (_intentSentence) _lastPreResolvedIntent = _intentSentence.trim().slice(0, 120);
        }
        if (name === 'computer' && input.coordinate && input.coordinate.length === 2 && axg && axg.resolveActionTarget) {
          try {
            // Scale Claude coordinates to screen coordinates (AX uses screen coords)
            const _scaleFactor = typeof SCALE_FACTOR !== 'undefined' ? SCALE_FACTOR : 1;
            const _screenX = Math.round(input.coordinate[0] / _scaleFactor);
            const _screenY = Math.round(input.coordinate[1] / _scaleFactor);
            const _preResolved = axg.resolveActionTarget(_screenX, _screenY);
            if (_preResolved) {
              _lastPreResolvedTarget = _preResolved;
              console.log('[Agent] Pre-resolved target: "' + _preResolved.label + '" (' + _preResolved.role + ') in ' + (_preResolved.app || 'unknown'));
            }
          } catch (_e) { /* non-fatal */ }
        }

        let result;
        try {
          result = await executeToolCall(name, input);
        } catch (toolErr) {
          console.error(`[Agent] executeToolCall CRASHED: ${toolErr.message}\n${toolErr.stack}`);
          result = { error: `Tool execution failed: ${toolErr.message}` };
        }

        // PATCH: Set navigation flag on trajectory before next screenshot's addNode
        if (trajectory && name === 'computer' && input) {
          const _isNav = _isNavigationAction(input.action, input);
          if (_isNav) {
            trajectory._expectNavigation = true;
            console.log('[Agent] NAV action: ' + input.action + ' -> surprise suppressed for next screenshot');
          }
        }

        // === SCREEN CHANGE DETECTION ===
        // If ShowUI detected the screen changed since Claude's screenshot (drift > 200px),
        // don't execute the stale action. Instead, inject a fresh screenshot so Claude
        // can re-analyze the current state and decide the correct action.
        if (result && result.screen_changed && result.freshBase64) {
          console.log(`[Agent] Screen changed detected (drift: ${result.drift}px). Re-querying Claude with fresh screenshot.`);
          if (onStep) onStep({ type: 'screen_change_requery', iteration, drift: result.drift, target: result.target });

          // Return a tool_result with the fresh screenshot image so Claude sees current state
          // Also include a text explanation so Claude knows what happened
          toolResults.push({
            type: 'tool_result',
            tool_use_id: id,
            content: [
              { type: 'text', text: `[SCREEN CHANGED] The UI has changed since your last screenshot (element "${result.target}" moved ${result.drift}px from expected position). Here is a fresh screenshot of the CURRENT screen state. Please re-analyze and decide the correct action.` },
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: result.freshBase64 } },
            ],
            is_error: false,
          });
          // Skip the normal tool result handling - we already pushed the fresh screenshot
          // Track in trajectory as a screen-change event
          try {
            if (trajectory) {
              trajectory.addNode(
                result.freshBase64,
                { type: 'tool_use', name, input },
                'screen_changed'
              );
            }
          } catch (e) { console.error(`[Trajectory] screen_changed addNode error: ${e.message}`); }
          continue; // Skip to next block in this response (if any)
        }

        const stepData = {
          iteration,
          tool: name,
          action: actionName,
          input,
          result: result.error ? 'error' : 'success',
        };
        steps.push(stepData);
        if (onStep) onStep(stepData);

        // For screenshots, return image to Claude + track in trajectory
        // Native format: name='computer', input.action='screenshot'
        const isScreenshot = (name === 'computer' && input.action === 'screenshot') || name === 'screenshot';
        if (isScreenshot && result.base64) {
          // Track this screenshot in the trajectory graph (safe - never crashes agent)
          try {
            if (trajectory) {
              // Find the last NON-screenshot action (the action that preceded this screenshot)
              let prevAction = null;
              for (let si = steps.length - 2; si >= 0; si--) {
                if (steps[si].action !== 'screenshot') { prevAction = steps[si]; break; }
              }
              // === ACTION ENRICHMENT: resolve coordinates to element names ===
              let _resolvedTarget = null;
              let _assistantIntent = null;
              if (prevAction && prevAction.input) {
                const inp = prevAction.input;
                // Resolve click coordinates against AX cache
                // Use pre-resolved target (captured before cache invalidation)
                if (_lastPreResolvedTarget) {
                  _resolvedTarget = _lastPreResolvedTarget;
                  _lastPreResolvedTarget = null;
                } else if (inp.coordinate && inp.coordinate.length === 2 && axg && axg.resolveActionTarget) {
                  try {
                    _resolvedTarget = axg.resolveActionTarget(inp.coordinate[0], inp.coordinate[1]);
                  } catch (_e) { /* non-fatal */ }
                }
                // Extract assistant's stated intent from the last assistant message
                for (let mi = messages.length - 1; mi >= 0; mi--) {
                  if (messages[mi].role === 'assistant') {
                    const txt = typeof messages[mi].content === 'string' ? messages[mi].content :
                      (Array.isArray(messages[mi].content) ? messages[mi].content.filter(b => b.type === 'text').map(b => b.text).join(' ') : '');
                    if (txt && txt.length > 10) {
                      // Take the first meaningful sentence (the intent)
                      const firstSentence = txt.split(/[.!\n]/).filter(s => s.trim().length > 10)[0];
                      if (firstSentence) {
                        _assistantIntent = firstSentence.trim().slice(0, 120);
                      }
                    }
                    break;
                  }
                }
              }

              const trajResult = trajectory.addNode(
                result.base64,
                prevAction ? { type: 'tool_use', name: prevAction.tool, input: prevAction.input } : null,
                prevAction ? prevAction.result : null,
                _resolvedTarget || null  // Pass AX context so action summary includes semantic target
              );

              // Use pre-resolved intent if available
              if (_lastPreResolvedIntent && !_assistantIntent) {
                _assistantIntent = _lastPreResolvedIntent;
                _lastPreResolvedIntent = null;
              }

              // Inject enrichment data into the node AFTER creation
              const _lastNode = trajectory.nodes[trajectory.nodes.length - 1];
              if (_lastNode) {
                if (_resolvedTarget) _lastNode.resolvedTarget = _resolvedTarget;
                if (_assistantIntent) _lastNode.assistantIntent = _assistantIntent;
                // Re-run auto semantic state with the enriched data
                _lastNode.semanticState = null;  // Clear the auto-generated one
                trajectory._autoSemanticState(_lastNode);
                if (_resolvedTarget) {
                  console.log('[Agent] Action enriched: ' + _lastNode.semanticState);
                }
              }

              if (trajResult.loopDetected) {
                stepData.loopDetected = true;
                stepData.matchedStep = trajResult.matchedNodeId;
                loopCount++;
                trajectory.trackIssue();
                const recoveryLvl = trajectory.getRecoveryLevel();
                console.log(`[Agent] LOOP DETECTED at iteration ${iteration}: matches ${trajResult.matchedNodeId} (${trajResult.stepsBack} steps back) [loops: ${loopCount}, recovery: L${recoveryLvl}]`);
                if (onStep) onStep({ type: 'loop_detected', iteration, matchedStep: trajResult.matchedNodeId, stepsBack: trajResult.stepsBack, recoveryLevel: recoveryLvl });
              }
              if (trajResult.stagnationDetected) {
                stepData.stagnationDetected = true;
                stagnationCount++;
                trajectory.trackIssue();
                const recoveryLvl = trajectory.getRecoveryLevel();
                console.log(`[Agent] STAGNATION at iteration ${iteration}: last action had no visible effect [stagnations: ${stagnationCount}, recovery: L${recoveryLvl}]`);
                if (onStep) onStep({ type: 'stagnation_detected', iteration, recoveryLevel: recoveryLvl });
              }
              if (trajResult.surpriseDetected) {
                stepData.surpriseDetected = true;
                stepData.surpriseScore = trajResult.surpriseScore;
                const recoveryLvl = trajectory.getRecoveryLevel();
                console.log(`[Agent] SURPRISE at iteration ${iteration}: expectation mismatch (score: ${trajResult.surpriseScore.toFixed(2)}) [recovery: L${recoveryLvl}]`);
                if (onStep) onStep({ type: 'surprise_detected', iteration, surpriseScore: trajResult.surpriseScore, recoveryLevel: recoveryLvl });
              }

              // === BRANCH MANAGEMENT ===
              // When an issue triggers recovery level 1+, close the current branch
              // as failed and start a new one from the nearest checkpoint.
              const issueDetected = trajResult.loopDetected || trajResult.stagnationDetected || trajResult.surpriseDetected;
              if (issueDetected) {
                // Branch on ANY issue if: checkpoints exist, enough budget remains, branch had fair shot
                const remainingBudget = maxIter - iteration;
                if (trajectory.checkpoints.length > 0 && remainingBudget >= 5) {
                  const activeBranch = trajectory.branches[trajectory.activeBranchIndex];
                  // Only branch if current branch has had 3+ frames (avoid rapid churn)
                  const framesInBranch = (trajectory.nodes.length - 1) - (activeBranch?.startFrameIndex || 0);
                  if (framesInBranch >= 3) {
                    // Auto-generate failure description
                    let failureType = 'encountered an issue';
                    if (trajResult.loopDetected) failureType = `hit a loop (same screen as ${trajResult.matchedNodeId})`;
                    else if (trajResult.stagnationDetected) failureType = 'action had no visible effect (stagnation)';
                    else if (trajResult.surpriseDetected) failureType = `unexpected result (surprise score: ${trajResult.surpriseScore.toFixed(2)})`;

                    const lesson = trajectory._autoLesson(failureType);
                    trajectory.closeBranch('failed', failureType, lesson);

                    // Start new branch from nearest checkpoint
                    const lastCp = trajectory.getLastCheckpoint();
                    const branchName = trajectory._autoBranchName();
                    trajectory.createBranch(branchName, `retry after: ${failureType.slice(0, 50)}`, lastCp.nodeIndex);

                    // Compute navigation plan for the checkpoint we're returning to
                    const navPlan = trajectory.computeNavigationPlan();
                    console.log(`[Agent] BRANCH: closed failed branch, started "${branchName}" from checkpoint [${lastCp.stepNumber}]`);
                    if (navPlan.actions.length > 0) {
                      console.log(`[Agent] NAV PLAN: ${navPlan.actions.length} compensating actions, cost=${navPlan.estimatedCost}, ${navPlan.actionsSinceCheckpoint} actions to undo`);
                      for (const act of navPlan.actions) {
                        if (act.action !== 'screenshot') {
                          console.log(`[Agent]   -> ${act.text}${act.repeat > 1 ? ' x' + act.repeat : ''}: ${act.reason}`);
                        }
                      }
                    }
                    if (onStep) onStep({ type: 'branch_created', branchName, lesson, fromCheckpoint: lastCp.stepNumber, navigationPlan: navPlan });
                  }
                }
              }
            }
          } catch (e) { console.error(`[Trajectory] addNode error: ${e.message}`); }

          // === NAVIGATION VERIFICATION ===
          // After a branch switch, check if the agent arrived at the target checkpoint
          if (trajectory && trajectory.branches.length > 1) {
            const activeBranch = trajectory.branches[trajectory.activeBranchIndex];
            if (activeBranch && activeBranch.startFrameIndex >= trajectory.nodes.length - 3) {
              // We're within 3 frames of a branch start — check navigation
              const cpIdx = trajectory.checkpoints.findIndex(cp => cp.nodeIndex === activeBranch.baseFrameIndex);
              if (cpIdx >= 0) {
                const navResult = trajectory.verifyNavigation(cpIdx);
                if (navResult.match === 'exact' || navResult.match === 'perceptual') {
                  console.log(`[Agent] NAV VERIFIED: ${navResult.match} match — arrived at checkpoint [${trajectory.checkpoints[cpIdx].stepNumber}]`);
                  if (onStep) onStep({ type: 'navigation_verified', match: navResult.match, checkpoint: trajectory.checkpoints[cpIdx].stepNumber });
                } else if (trajectory.nodes.length > activeBranch.startFrameIndex + 2) {
                  // Give 2 frames grace period, then flag
                  console.log(`[Agent] NAV CHECK: screenshot does not match checkpoint (may still be navigating)`);
                }
              }
            }
          }

          // Build screenshot tool result content
          const screenshotContent = [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: result.base64 } },
          ];

          // Checkpoint reminder: nudge agent if no checkpoint declared recently
          if (trajectory) {
            const nodeCount = trajectory.nodes.length;
            const lastCpNodeIdx = trajectory.checkpoints.length > 0
              ? trajectory.checkpoints[trajectory.checkpoints.length - 1].nodeIndex
              : -1;
            const stepsSinceCheckpoint = nodeCount - 1 - lastCpNodeIdx;
            if (nodeCount >= 4 && stepsSinceCheckpoint >= 4) {
              screenshotContent.push({
                type: 'text',
                text: '[SYSTEM REMINDER: You have not declared a CHECKPOINT in the last ' + stepsSinceCheckpoint + ' actions. Every successful plan step MUST have a CHECKPOINT declaration. Declare one NOW if any progress was made.]',
              });
              console.log('[Agent] Checkpoint reminder injected (' + stepsSinceCheckpoint + ' steps since last checkpoint)');
            }
          }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: id,
            content: screenshotContent,
          });
        } else {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: id,
            content: [{ type: 'text', text: JSON.stringify(result) }],
            is_error: !!result.error,
          });
        }
      }
    }

    // If no tool calls, agent is done
    if (toolResults.length === 0) {
      // Clean up display wake process
      if (caffeinatePid) { try { process.kill(caffeinatePid); } catch(e) {} }
      const checkpointCount = trajectory ? trajectory.checkpoints.length : 0;
      const planSteps = trajectory?.taskPlan?.totalSteps || 0;
      // ShowUI-2B grounding stats
      if (SHOWUI_ENABLED && _showuiStats.queries > 0) {
        console.log('[ShowUI] Stats: ' + _showuiStats.queries + ' queries, ' + _showuiStats.refined + ' refined, ' + _showuiStats.failures + ' failures, avg ' + Math.round(_showuiStats.totalMs / _showuiStats.queries) + 'ms');
        if (onStep) onStep({ type: 'showui_stats', queries: _showuiStats.queries, refined: _showuiStats.refined, failures: _showuiStats.failures, avgMs: Math.round(_showuiStats.totalMs / _showuiStats.queries) });
      }
      console.log(`[Agent] Task complete after ${iteration} iterations (model: ${MODELS[currentModel].label}, escalated: ${escalated}, checkpoints: ${checkpointCount}/${planSteps})`);
      let viewerPath = null;
      try { if (trajectory) viewerPath = trajectory.complete(true, finalText); }
      catch (e) { console.error(`[Trajectory] complete error: ${e.message}`); }
      if (viewerPath) console.log(`[Agent] Trajectory viewer: ${viewerPath}`);

      // === LEARNING PIPELINE (async, non-blocking) ===
      // Run post-mortem, segment extraction, and skill graduation in the background.
      // This MUST NOT block the response to the user.
      learnFromTrajectory(taskId, finalText).then(learningResult => {
        console.log(`[Learning] Background pipeline done: ${JSON.stringify(learningResult)}`);
      }).catch(e => {
        console.error(`[Learning] Background pipeline error: ${e.message}`);
      });

      return { success: true, iterations: iteration, steps, finalText, messages, trajectoryId: taskId, trajectoryViewer: viewerPath, model: MODELS[currentModel].id, escalated, checkpoints: checkpointCount, planSteps };
    }

    // Add tool results for next iteration
    messages.push({ role: 'user', content: toolResults });

    // Memory management handled by contextManager.assembleContext() above
  }

  // Clean up display wake process
  if (caffeinatePid) { try { process.kill(caffeinatePid); } catch(e) {} }

  const checkpointCount = trajectory ? trajectory.checkpoints.length : 0;
  const planSteps2 = trajectory?.taskPlan?.totalSteps || 0;

  // Max iterations exhausted - determine success from checkpoint progress
  const completionRatio = (planSteps2 > 0 && checkpointCount > 0) ? checkpointCount / planSteps2 : 0;
  const maxIterSuccess = completionRatio >= 0.8; // 80%+ checkpoints = success
  const maxIterStatus = maxIterSuccess ? 'completed' : (checkpointCount > 0 ? 'partial' : 'failed');
  console.log(`[Agent] Completed ${maxIter} iterations (model: ${MODELS[currentModel].label}, escalated: ${escalated}, checkpoints: ${checkpointCount}/${planSteps2})`);
  console.log(`[Agent] Max iterations reached. Status: ${maxIterStatus} (checkpoints: ${checkpointCount}/${planSteps2}, ratio: ${(completionRatio * 100).toFixed(0)}%)`);

  let viewerPath = null;
  try { if (trajectory) viewerPath = trajectory.complete(completionRatio >= 0.8, completionRatio >= 0.8 ? 'Task completed after extended run' : 'Task incomplete - max iterations reached'); }
  catch (e) { console.error(`[Trajectory] complete error: ${e.message}`); }
  if (viewerPath) console.log(`[Agent] Trajectory viewer: ${viewerPath}`);

  // === LEARNING PIPELINE (async, non-blocking) ===
  learnFromTrajectory(taskId, maxIterStatus === 'failed' ? 'Task failed - max iterations exhausted' : 'Task completed after extended run').then(learningResult => {
    console.log(`[Learning] Background pipeline done: ${JSON.stringify(learningResult)}`);
  }).catch(e => {
    console.error(`[Learning] Background pipeline error: ${e.message}`);
  });

  return { success: maxIterSuccess, status: maxIterStatus, iterations: iteration, steps, finalText: maxIterSuccess ? 'Done! Took a lot of steps but got there.' : `Hit max iterations (${maxIter}). Completed ${checkpointCount}/${planSteps2} steps.`, messages, trajectoryId: taskId, trajectoryViewer: viewerPath, model: MODELS[currentModel].id, escalated, checkpoints: checkpointCount, planSteps: planSteps2 };
}

// ============================================================
// ROUTE MOUNTING
// ============================================================

function mountComputerUseRoutes(app) {
  // PATCHED: Register AX grounding monitoring endpoints
  axg.setupRoutes(app);


  // -----------------------------------------------------------
  // AGENTIC ENDPOINT - Give a task, Opus 4.6 does it
  // -----------------------------------------------------------
  app.post('/computer/agent', async (req, res) => {
    let keepalive = null;
    let responseClosed = false;

    // Track client disconnect to avoid writing to closed socket
    res.on('close', () => {
      responseClosed = true;
      if (keepalive) clearInterval(keepalive);
    });

    try {
      const { task, apiKey, maxIterations, systemPrompt } = req.body;
      const key = apiKey || process.env.ANTHROPIC_API_KEY || AI_GATEWAY_KEY;
      if (!task) return res.status(400).json({ error: 'task required' });

      // BUG-10 FIX: Send keepalive headers to prevent proxy timeouts
      res.setHeader('X-Accel-Buffering', 'no');
      keepalive = setInterval(() => {
        if (responseClosed) { clearInterval(keepalive); return; }
        try { res.write(' '); } catch (e) { clearInterval(keepalive); }
      }, 15000);

      const result = await agentLoop(key, task, { maxIterations, systemPrompt });
      clearInterval(keepalive);
      keepalive = null;

      if (responseClosed) {
        console.log('[Agent] Client disconnected before response could be sent');
        return;
      }

      // Don't send full messages (too large with screenshots), send summary
      res.end(JSON.stringify({
        success: result.success,
        iterations: result.iterations,
        steps: result.steps,
        finalText: result.finalText,
        error: result.error,
        model: result.model,
        escalated: result.escalated,
        trajectoryId: result.trajectoryId,
        trajectoryViewer: result.trajectoryViewer,
        checkpoints: result.checkpoints,
        planSteps: result.planSteps,
      }));
    } catch (err) {
      if (keepalive) clearInterval(keepalive);
      if (!responseClosed) {
        try { res.status(500).json({ error: err.message }); } catch (e) {}
      }
      console.error(`[Agent] Endpoint error: ${err.message}\n${err.stack}`);
    }
  });

  // -----------------------------------------------------------
  // STREAMING AGENTIC ENDPOINT - SSE stream of each step
  // -----------------------------------------------------------
  app.post('/computer/agent/stream', async (req, res) => {
    try {
      const { task, apiKey, maxIterations, systemPrompt } = req.body;
      const key = apiKey || process.env.ANTHROPIC_API_KEY || AI_GATEWAY_KEY;
      if (!task) return res.status(400).json({ error: 'task required' });

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const sendEvent = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      sendEvent({ type: 'start', task, model: MODELS[DEFAULT_MODEL].id, escalationModel: MODELS.opus.id, screen: { width: SCREEN_W, height: SCREEN_H } });

      const result = await agentLoop(key, task, {
        maxIterations,
        systemPrompt,
        onStep: (step) => sendEvent({ type: 'step', ...step }),
      });

      sendEvent({ type: 'done', success: result.success, iterations: result.iterations, finalText: result.finalText, model: result.model, escalated: result.escalated, checkpoints: result.checkpoints, planSteps: result.planSteps });
      res.end();
    } catch (err) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
      res.end();
    }
  });

  // -----------------------------------------------------------
  // ACTION ENDPOINTS (manual control)
  // -----------------------------------------------------------
  app.post('/computer/screenshot', (req, res) => {
    try { res.json(ACTIONS.screenshot(req.body || {})); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // BUG-01/07 FIX: async route handler supports wait/hold_key
  app.post('/computer/action', async (req, res) => {
    try {
      const { action, ...params } = req.body;
      if (!action) return res.status(400).json({ error: 'action required' });
      const result = await executeAction(action, params);
      res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // BUG-01/16 FIX: async with inter-action delays
  app.post('/computer/actions', async (req, res) => {
    try {
      const { actions, delay: globalDelay } = req.body;
      if (!actions || !Array.isArray(actions)) return res.status(400).json({ error: 'actions array required' });
      const results = [];
      for (const { action, ...params } of actions) {
        const r = await executeAction(action, params);
        results.push(r);
        // BUG-16 FIX: configurable inter-action delay (default 50ms)
        await _sleepAsync(globalDelay || params.delay || 50);
      }
      res.json({ results });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/computer/info', (req, res) => {
    try { res.json(getInfo()); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/computer/app', (req, res) => {
    try {
      if (!req.body.name) return res.status(400).json({ error: 'name required' });
      _osascript(`tell application "${req.body.name}" to activate`); _sleep(200); // Reduced from 500ms
      res.json({ activated: true, app: req.body.name });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/computer/open', (req, res) => {
    try {
      if (!req.body.target) return res.status(400).json({ error: 'target required' });
      execSync(`open "${req.body.target}"`, { timeout: 10000 });
      res.json({ opened: true, target: req.body.target });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/computer/actions', (req, res) => {
    res.json({
      actions: Object.keys(ACTIONS),
      spec: TOOL_VERSION,
      model: ANTHROPIC_MODEL,
      beta: BETA_FLAG,
      screen: { width: SCREEN_W, height: SCREEN_H },
      scaled: { width: SCALED_W, height: SCALED_H, factor: SCALE_FACTOR },
      nativeToolFormat: true,
    });
  });

  // -----------------------------------------------------------

  // -----------------------------------------------------------
  // BISECT - Binary search for root cause in a trajectory
  // -----------------------------------------------------------
  app.post('/computer/bisect', async (req, res) => {
    try {
      const { trajectoryId, goodStep, badStep, apiKey } = req.body;
      if (!trajectoryId) return res.status(400).json({ error: 'trajectoryId required' });

      // Load trajectory from disk
      const traj = loadTrajectory(trajectoryId);
      if (!traj) return res.status(404).json({ error: `Trajectory ${trajectoryId} not found` });
      if (traj.nodes.length < 2) return res.status(400).json({ error: 'Trajectory has fewer than 2 frames' });

      const key = apiKey || process.env.ANTHROPIC_API_KEY || AI_GATEWAY_KEY;
      const taskDesc = traj.taskDescription || 'unknown task';

      // LLM judge function: sends screenshot to Sonnet, asks good/bad
      const judgeFn = async (frame) => {
        if (!frame.screenshotPath || !fs.existsSync(frame.screenshotPath)) {
          // No screenshot available -- infer from flags
          if (frame.flags.includes('loop') || frame.flags.includes('surprise')) return 'bad';
          if (frame.flags.includes('checkpoint')) return 'good';
          return 'good'; // Default to good if we can't see the screenshot
        }

        const imgData = fs.readFileSync(frame.screenshotPath);
        const base64 = imgData.toString('base64');
        const mediaType = frame.screenshotPath.endsWith('.jpg') ? 'image/jpeg' : 'image/png';

        const judgePrompt = `You are a binary search judge for a computer-use agent debugging tool.

The agent was performing this task: "${taskDesc}"

Look at this screenshot from step ${frame.index} of the trajectory.
The agent's action at this step was: ${frame.action?.raw || 'none'}
Action result: ${typeof frame.toolResult === 'string' ? frame.toolResult.slice(0, 200) : JSON.stringify(frame.toolResult || '').slice(0, 200)}

Determine if the screen state is:
- GOOD: The agent is on track. The task is progressing correctly. The screen shows expected state.
- BAD: Something has gone wrong. The agent is off track, in a wrong app, seeing an error, stuck, or the task has derailed.

Reply with EXACTLY one word: GOOD or BAD`;

        const messages = [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: judgePrompt },
          ],
        }];

        try {
          const response = await new Promise((resolve, reject) => {
            callLLM(key, messages, 'You are a precise screenshot analysis judge. Reply with exactly one word: GOOD or BAD.', 'sonnet')
              .then(resolve)
              .catch(reject);
          });

          // Parse response
          const responseText = (response.content || [])
            .filter(c => c.type === 'text')
            .map(c => c.text)
            .join(' ')
            .trim()
            .toUpperCase();

          if (responseText.includes('BAD')) return 'bad';
          if (responseText.includes('GOOD')) return 'good';
          // Ambiguous -- default to good (conservative)
          console.log(`[Bisect] Ambiguous judge response at frame ${frame.index}: "${responseText.slice(0, 50)}"`);
          return 'good';
        } catch (err) {
          console.error(`[Bisect] LLM judge failed at frame ${frame.index}:`, err.message);
          // Fallback: use flags
          if (frame.flags.includes('loop') || frame.flags.includes('surprise')) return 'bad';
          return 'good';
        }
      };

      console.log(`[Bisect] Starting bisect on ${trajectoryId}: ${traj.nodes.length} frames, task: "${taskDesc.slice(0, 60)}"`);

      const result = await traj.bisect(
        goodStep || 0,
        badStep !== undefined ? badStep : null,
        judgeFn
      );

      // Save bisect result alongside trajectory
      const bisectPath = path.join(TRAJECTORY_DIR, trajectoryId, 'bisect-result.json');
      fs.writeFileSync(bisectPath, JSON.stringify(result, null, 2));
      console.log(`[Bisect] Result saved to ${bisectPath}`);

      // Also update trajectory.json with bisect info
      const trajDataPath = path.join(TRAJECTORY_DIR, trajectoryId, 'trajectory.json');
      try {
        const trajData = JSON.parse(fs.readFileSync(trajDataPath, 'utf8'));
        trajData.bisectResult = {
          culpritIndex: result.culpritIndex,
          culpritAction: result.culpritAction,
          stepsChecked: result.stepsChecked,
          confidence: result.confidence,
          timestamp: Date.now(),
        };
        fs.writeFileSync(trajDataPath, JSON.stringify(trajData, null, 2));
      } catch (e) {
        console.error('[Bisect] Could not update trajectory.json:', e.message);
      }

      res.json({
        success: true,
        trajectoryId,
        taskDescription: taskDesc,
        ...result,
      });
    } catch (err) {
      console.error('[Bisect] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });


  // TRAJECTORY ROUTES - View agent execution history
  // -----------------------------------------------------------

  // List all trajectories
  app.get('/trajectories', (req, res) => {
    try {
      const trajectories = listTrajectories();
      res.json({ trajectories });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get trajectory JSON data
  app.get('/trajectories/:id', (req, res) => {
    try {
      const trajPath = path.join(TRAJECTORY_DIR, req.params.id, 'trajectory.json');
      if (!fs.existsSync(trajPath)) return res.status(404).json({ error: 'Trajectory not found' });
      const data = JSON.parse(fs.readFileSync(trajPath, 'utf8'));
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Serve the HTML viewer for a trajectory
  app.get('/trajectories/:id/viewer', (req, res) => {
    try {
      const viewerPath = path.join(TRAJECTORY_DIR, req.params.id, 'viewer.html');
      if (!fs.existsSync(viewerPath)) {
        // Try regenerating from trajectory.json
        const trajPath = path.join(TRAJECTORY_DIR, req.params.id, 'trajectory.json');
        if (!fs.existsSync(trajPath)) return res.status(404).json({ error: 'Trajectory not found' });
        return res.status(404).json({ error: 'Viewer not generated yet. Run the task first.' });
      }
      res.sendFile(viewerPath);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Serve individual screenshot for a trajectory step
  app.get('/trajectories/:id/screenshots/:step', (req, res) => {
    try {
      const pngPath = path.join(TRAJECTORY_DIR, req.params.id, `${req.params.step}.png`);
      if (fs.existsSync(pngPath)) return res.sendFile(pngPath);
      const jpgPath = path.join(TRAJECTORY_DIR, req.params.id, `${req.params.step}.jpg`);
      if (fs.existsSync(jpgPath)) return res.sendFile(jpgPath);
      return res.status(404).json({ error: 'Screenshot not found' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Trajectory dashboard - lists all trajectories with links to viewers
  app.get('/trajectory-dashboard', (req, res) => {
    try {
      const trajectories = listTrajectories();
      const html = generateTrajectoryDashboard(trajectories);
      res.send(html);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  console.log(`[ComputerUse] SOTA Agent: ${MODELS.sonnet.label} (fast) -> ${MODELS.opus.label} (adaptive escalation: base ${ESCALATION_THRESHOLD_BASE} + planSteps)`);
  console.log(`[ComputerUse] Graph: Task planning + Checkpoints + 4-level backtracking + Recovery escalation`);
  console.log(`[ComputerUse] Spec: ${TOOL_VERSION}, Beta: ${BETA_FLAG}`);
  console.log(`[ComputerUse] Screen: ${SCREEN_W}x${SCREEN_H} -> Scaled: ${SCALED_W}x${SCALED_H} (factor: ${SCALE_FACTOR.toFixed(4)}), Actions: ${Object.keys(ACTIONS).length}`);
  console.log('[ComputerUse] Routes mounted at /computer/*');
}

// ============================================================
// TRAJECTORY DASHBOARD
// ============================================================
function generateTrajectoryDashboard(trajectories) {
  const rows = trajectories.map(t => {
    const date = new Date(t.startTime).toLocaleString();
    const dur = t.duration ? (t.duration / 1000).toFixed(1) + 's' : '-';
    const status = t.success === true ? 'Success' : t.success === false ? 'Failed' : 'In Progress';
    const statusClass = t.success === true ? 'success' : t.success === false ? 'failure' : 'progress';
    return `<tr>
      <td><a href="/trajectories/${t.taskId}/viewer" target="_blank">${t.taskId.slice(0, 20)}</a></td>
      <td>${(t.taskDescription || '-').slice(0, 60)}</td>
      <td class="${statusClass}">${status}</td>
      <td>${t.totalSteps || 0}</td>
      <td>${dur}</td>
      <td>${t.loopsDetected || 0}</td>
      <td>${t.stagnationsDetected || 0}</td>
      <td>${date}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Trajectory Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #0a0a0f; color: #e0e0e0; padding: 32px; }
  h1 { font-size: 24px; margin-bottom: 24px; color: #fff; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 12px 16px; background: #1a1a2e; color: #888; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
  td { padding: 12px 16px; border-bottom: 1px solid #1a1a2e; font-size: 14px; }
  tr:hover { background: rgba(255,255,255,0.03); }
  a { color: #3b82f6; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .success { color: #4ade80; font-weight: 600; }
  .failure { color: #f87171; font-weight: 600; }
  .progress { color: #fbbf24; font-weight: 600; }
  .empty { text-align: center; padding: 48px; color: #555; }
</style></head>
<body>
  <h1>Agent Trajectory Dashboard</h1>
  ${trajectories.length === 0 ? '<div class="empty">No trajectories recorded yet. Run a computer-use agent task to create one.</div>' :
  `<table>
    <thead><tr><th>ID</th><th>Task</th><th>Status</th><th>Steps</th><th>Duration</th><th>Loops</th><th>Stagnations</th><th>Time</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`}
</body></html>`;
}

// ShowUI diagnostic
function getShowUIStatus() {
  return {
    enabled: SHOWUI_ENABLED,
    ready: _showuiReady,
    workerAlive: _showuiProc && !_showuiProc.killed,
    workerPid: _showuiProc ? _showuiProc.pid : null,
    stats: _showuiStats,
    bufferLen: _showuiBuffer.length,
    pendingCallbacks: Object.keys(_showuiCallbacks).length,
  };
}

module.exports = { mountComputerUseRoutes, axGrounding: axg, executeAction, executeActionSync, agentLoop, ACTIONS, getInfo, SCREEN_W, SCREEN_H, SCALED_W, SCALED_H, SCALE_FACTOR, setMacroRecorder, queryShowUI, getShowUIStatus };
require('./ax-grounding').invalidateCache(); // Force fresh AX tree after every action
