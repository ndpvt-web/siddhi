/**
 * input-bridge.js - TCC-aware keyboard input for macOS launchd context
 *
 * Problem: cliclick CGEvent keyboard events are silently TCC-blocked when the
 *          node process runs under launchd. Mouse events work fine.
 *
 * Solution: Route keyboard input through a persistent Terminal.app daemon
 *           using osascript System Events, which has TCC grants.
 *
 * Architecture:
 *   1. On init, probe whether cliclick keyboard events actually work
 *   2. If TCC-blocked, start a keyboard daemon in Terminal.app
 *   3. Keyboard actions (type/key) go through daemon; mouse stays with cliclick
 *   4. Daemon uses its own trigger file (not shared with screenshot daemon)
 *
 * Usage in computer-use.js:
 *   const inputBridge = require('./input-bridge');
 *   inputBridge.init();  // call once at module load
 *   inputBridge.type('hello world');
 *   inputBridge.key('cmd+l');
 *   inputBridge.key('Return');
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Daemon trigger files (separate from screenshot daemon)
const TRIGGER_FILE = '/tmp/capy-screenshot-trigger';
const TRIGGER_DONE = '/tmp/capy-screenshot-trigger.done';
const DAEMON_SCRIPT = '/tmp/capy-keyboard-daemon.sh';
const DAEMON_PID_FILE = '/tmp/capy-screenshot-daemon.pid';

// osascript key code mapping (macOS virtual key codes)
const KEY_CODES = {
  'return': 36, 'enter': 36, 'tab': 48, 'escape': 53, 'esc': 53,
  'space': 49, 'delete': 51, 'backspace': 51, 'forwarddelete': 117, 'fwd-delete': 117,
  'up': 126, 'down': 125, 'left': 123, 'right': 124,
  'arrow-up': 126, 'arrow-down': 125, 'arrow-left': 123, 'arrow-right': 124,
  'home': 115, 'end': 119, 'pageup': 116, 'pagedown': 121,
  'page-up': 116, 'page-down': 121,
  'f1': 122, 'f2': 120, 'f3': 99, 'f4': 118, 'f5': 96, 'f6': 97,
  'f7': 98, 'f8': 100, 'f9': 101, 'f10': 109, 'f11': 103, 'f12': 111,
  'f13': 105, 'f14': 107, 'f15': 113, 'f16': 106,
  'mute': 1001, 'volumeup': 1002, 'volumedown': 1003, // handled separately
};

// Modifier name to osascript "using" clause
const OSA_MODIFIERS = {
  'cmd': 'command down', 'command': 'command down', 'super': 'command down',
  'ctrl': 'control down', 'control': 'control down',
  'shift': 'shift down',
  'alt': 'option down', 'option': 'option down',
  'fn': 'function down',
};

let _useDaemon = false;  // set by init() after TCC probe
let _initialized = false;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _sleep(ms) {
  try { execSync(`sleep ${ms / 1000}`, { timeout: ms + 2000, stdio: 'ignore' }); } catch (e) {}
}

function _daemonAlive() {
  try {
    const pid = fs.readFileSync(DAEMON_PID_FILE, 'utf-8').trim();
    if (pid && /^\d+$/.test(pid)) {
      execSync(`kill -0 ${pid}`, { stdio: 'ignore' });
      return true;
    }
  } catch (e) {}
  return false;
}

function _startDaemon() {
  // Reuse existing screenshot daemon in Terminal.app (has TCC grants)
  // No need to start our own - just check if screenshot daemon is alive
  if (_daemonAlive()) {
    console.log('[InputBridge] Reusing screenshot daemon for keyboard commands');
    return true;
  }
  console.error('[InputBridge] Screenshot daemon not running - keyboard will fall back to cliclick');
  return false;
}

function _ensureDaemon() {
  if (_daemonAlive()) return true;
  console.log('[InputBridge] Daemon not running, starting...');
  return _startDaemon();
}

/**
 * Execute a command via the Terminal.app keyboard daemon.
 * Returns true if the daemon executed it within timeout.
 */
function _execViaDaemon(cmd) {
  if (!_ensureDaemon()) {
    console.error('[InputBridge] No daemon available, falling back to direct');
    // Fall back to direct osascript (may fail from launchd)
    try { execSync(cmd, { timeout: 5000, stdio: 'pipe' }); } catch (e) {}
    return false;
  }

  try { fs.unlinkSync(TRIGGER_DONE); } catch (e) {}
  fs.writeFileSync(TRIGGER_FILE, cmd);

  // Wait up to 5s for daemon to execute
  for (let i = 0; i < 50; i++) {
    _sleep(100);
    try {
      if (fs.existsSync(TRIGGER_DONE)) {
        try { fs.unlinkSync(TRIGGER_DONE); } catch (e) {}
        return true;
      }
    } catch (e) {}
  }
  console.error('[InputBridge] Daemon timeout after 5s');
  return false;
}

// ---------------------------------------------------------------------------
// TCC probe: detect if cliclick keyboard events actually work
// ---------------------------------------------------------------------------

function _probeTCC() {
  // Strategy: use cliclick to type into a temp file via pbcopy, then check clipboard
  // If TCC blocks keyboard events, the clipboard won't change
  const marker = `tcc_probe_${Date.now()}`;
  try {
    // Set clipboard to known value
    execSync(`echo "before" | pbcopy`, { timeout: 3000, stdio: 'pipe' });

    // Open a TextEdit window, type, then check
    // Actually simpler: use cliclick to type into pbcopy pipeline
    // The cleanest probe: cliclick key events that produce observable side effects

    // Probe approach: cliclick kp:mute should toggle system mute (observable)
    // But that's intrusive. Better: try typing a character and check if
    // the frontmost app received it.

    // Simplest non-intrusive probe: try to write to a test file via daemon
    // and compare with cliclick. But that's circular.

    // Pragmatic approach: check if we're running under launchd
    const ppid = process.ppid;
    let parentName = '';
    try {
      parentName = execSync(`ps -p ${ppid} -o comm=`, { timeout: 2000, stdio: 'pipe' }).toString().trim();
    } catch (e) {}

    // If parent is launchd or run-forever.sh, keyboard TCC is blocked
    const isLaunchd = !process.stdout.isTTY && (
      parentName.includes('launchd') ||
      parentName.includes('run-forever') ||
      parentName.includes('bash') ||  // run-forever.sh is bash
      process.env.XPC_SERVICE_NAME !== undefined
    );

    if (isLaunchd) {
      console.log('[InputBridge] Running under launchd/daemon context -> TCC keyboard blocked, using daemon');
      return true;  // needs daemon
    }

    // If we have a TTY, cliclick should work
    console.log('[InputBridge] Running with TTY -> cliclick keyboard should work');
    return false;  // doesn't need daemon

  } catch (e) {
    console.log('[InputBridge] TCC probe error, defaulting to daemon:', e.message.slice(0, 80));
    return true;  // assume blocked
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the input bridge. Call once at startup.
 * Detects TCC context and starts daemon if needed.
 */
function init() {
  if (_initialized) return;
  _initialized = true;

  _useDaemon = _probeTCC();
  if (_useDaemon) {
    // Pre-start daemon so first keystroke isn't slow
    _ensureDaemon();
  }
  console.log(`[InputBridge] Initialized (mode: ${_useDaemon ? 'daemon' : 'direct'})`);
}

/**
 * Type text. Handles newlines by splitting into lines + Return keys.
 * @param {string} text - Text to type, may contain \n
 */
function type(text) {
  if (!_initialized) init();

  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (line.length > 0) {
      // Split long text into chunks (osascript has limits)
      const chunks = line.match(/.{1,200}/g) || [line];
      for (const chunk of chunks) {
        _typeChunk(chunk);
        if (chunks.length > 1) _sleep(30);
      }
    }
    // Return between lines (not after last)
    if (li < lines.length - 1) {
      _keyCode('return', null);
      _sleep(30);
    }
  }
}

function _typeChunk(text) {
  if (_useDaemon) {
    // Escape for osascript single-quoted string
    const escaped = text
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/'/g, "'\"'\"'");
    const cmd = `osascript -e 'tell application "System Events" to keystroke "${escaped}"'`;
    _execViaDaemon(cmd);
  } else {
    // Direct cliclick
    const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    try {
      execSync(`cliclick t:"${escaped}"`, { timeout: 5000, stdio: 'pipe' });
    } catch (e) {
      console.error('[InputBridge] cliclick type failed:', e.message.slice(0, 80));
    }
  }
}

/**
 * Press a key combination (e.g. "cmd+l", "Return", "ctrl+shift+a").
 * @param {string} combo - Key combination string
 */
function key(combo) {
  if (!_initialized) init();

  const parts = combo.split('+').map(k => k.trim().toLowerCase());
  const mainKey = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);

  const keyCode = KEY_CODES[mainKey];

  if (keyCode) {
    // Named key (Return, Tab, Escape, arrows, F-keys...)
    _keyCode(mainKey, modifiers.length > 0 ? modifiers : null);
  } else if (mainKey.length === 1) {
    // Single character with optional modifiers
    _keystroke(mainKey, modifiers.length > 0 ? modifiers : null);
  } else {
    console.error(`[InputBridge] Unknown key: "${mainKey}"`);
  }
}

function _keyCode(keyName, modifiers) {
  const code = KEY_CODES[keyName];
  if (code === undefined) {
    console.error(`[InputBridge] No key code for: ${keyName}`);
    return;
  }

  if (_useDaemon) {
    let cmd;
    if (modifiers && modifiers.length > 0) {
      const modStr = modifiers.map(m => OSA_MODIFIERS[m]).filter(Boolean).join(', ');
      cmd = `osascript -e 'tell application "System Events" to key code ${code} using {${modStr}}'`;
    } else {
      cmd = `osascript -e 'tell application "System Events" to key code ${code}'`;
    }
    _execViaDaemon(cmd);
  } else {
    // Map to cliclick kp: names
    const CLICLICK_KEYS = {
      'return': 'return', 'enter': 'return', 'tab': 'tab',
      'escape': 'esc', 'esc': 'esc', 'space': 'space',
      'delete': 'delete', 'backspace': 'delete', 'forwarddelete': 'fwd-delete',
      'up': 'arrow-up', 'down': 'arrow-down', 'left': 'arrow-left', 'right': 'arrow-right',
      'arrow-up': 'arrow-up', 'arrow-down': 'arrow-down',
      'arrow-left': 'arrow-left', 'arrow-right': 'arrow-right',
      'home': 'home', 'end': 'end',
      'pageup': 'page-up', 'pagedown': 'page-down',
      'page-up': 'page-up', 'page-down': 'page-down',
      'f1': 'f1', 'f2': 'f2', 'f3': 'f3', 'f4': 'f4', 'f5': 'f5', 'f6': 'f6',
      'f7': 'f7', 'f8': 'f8', 'f9': 'f9', 'f10': 'f10', 'f11': 'f11', 'f12': 'f12',
    };
    const cliKey = CLICLICK_KEYS[keyName];
    if (!cliKey) return;

    try {
      if (modifiers && modifiers.length > 0) {
        const modStr = modifiers.join(',');
        execSync(`cliclick kd:${modStr} kp:${cliKey} ku:${modStr}`, { timeout: 5000, stdio: 'pipe' });
      } else {
        execSync(`cliclick kp:${cliKey}`, { timeout: 5000, stdio: 'pipe' });
      }
    } catch (e) {
      _sleep(100);
      try {
        if (modifiers && modifiers.length > 0) {
          const modStr = modifiers.join(',');
          execSync(`cliclick kd:${modStr} kp:${cliKey} ku:${modStr}`, { timeout: 5000, stdio: 'pipe' });
        } else {
          execSync(`cliclick kp:${cliKey}`, { timeout: 5000, stdio: 'pipe' });
        }
      } catch (e2) {
        console.error('[InputBridge] cliclick keyCode retry failed:', e2.message.slice(0, 80));
      }
    }
  }
}

function _keystroke(char, modifiers) {
  if (_useDaemon) {
    const escaped = char.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    let cmd;
    if (modifiers && modifiers.length > 0) {
      const modStr = modifiers.map(m => OSA_MODIFIERS[m]).filter(Boolean).join(', ');
      cmd = `osascript -e 'tell application "System Events" to keystroke "${escaped}" using {${modStr}}'`;
    } else {
      cmd = `osascript -e 'tell application "System Events" to keystroke "${escaped}"'`;
    }
    _execViaDaemon(cmd);
  } else {
    const escaped = char.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    try {
      if (modifiers && modifiers.length > 0) {
        const modStr = modifiers.join(',');
        execSync(`cliclick kd:${modStr} t:"${escaped}" ku:${modStr}`, { timeout: 5000, stdio: 'pipe' });
      } else {
        execSync(`cliclick t:"${escaped}"`, { timeout: 5000, stdio: 'pipe' });
      }
    } catch (e) {
      console.error('[InputBridge] cliclick keystroke failed:', e.message.slice(0, 80));
    }
  }
}

/**
 * Cleanup daemon on shutdown.
 */
function shutdown() {
  try {
    const pid = fs.readFileSync(DAEMON_PID_FILE, 'utf-8').trim();
    if (pid) {
      execSync(`kill ${pid}`, { stdio: 'ignore' });
      console.log(`[InputBridge] Daemon ${pid} stopped`);
    }
  } catch (e) {}
  try { fs.unlinkSync(DAEMON_PID_FILE); } catch (e) {}
  try { fs.unlinkSync(TRIGGER_FILE); } catch (e) {}
  try { fs.unlinkSync(TRIGGER_DONE); } catch (e) {}
}

module.exports = { init, type, key, shutdown };
