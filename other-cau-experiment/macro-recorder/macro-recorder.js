/**
 * Capy Macro Recorder - Server Module (Phase 2: Semantic Recording)
 *
 * Records user actions as macro steps with SEMANTIC grounding (role/label/path),
 * stores as .capymacro bundles, replays via intelligent tier cascade.
 *
 * Architecture:
 *   Recording: Accepts events via POST /macro/record/event
 *              Phase 2: Captures AX semantic target (role/label/path) at click coordinates
 *              Phase 1: Manual capture via /macro/record/capture endpoint
 *   Storage:   /tmp/capy-macros/<id>/manifest.json + screenshots/
 *   Replay:    Tier 0: Semantic AX search (NEW)
 *              Tier 1: Coordinate fallback (baseline)
 *              Tier 2: AX JXA matching (legacy)
 *              Tier 3: Vision AI fallback (expensive)
 *   Search:    FTS5 index with fuzzy name matching + semantic labels
 *
 * Endpoints:
 *   POST /macro/record/start    - Start recording session
 *   POST /macro/record/stop     - Stop recording, save bundle
 *   POST /macro/record/event    - Push an event during recording (captures semantic target)
 *   POST /macro/record/capture  - Capture current screen + mouse position as a step (semantic)
 *   GET  /macro/list            - List all saved macros
 *   GET  /macro/:id             - Get macro details
 *   DELETE /macro/:id           - Delete macro bundle
 *   POST /macro/replay/:id     - Replay macro (blocking, semantic-first)
 *   POST /macro/replay/:id/stream - Replay macro (SSE progress)
 *   POST /macro/:id/enrich      - Enrich existing macro with semantic data (NEW)
 *   GET  /macro/stream          - SSE event stream (pre-auth, exported)
 *
 * Phase 2 Changes:
 *   - Recording captures semantic target (AXButton[Save]) not just coordinates (450,320)
 *   - Replay uses semantic search FIRST, falls back to coordinates if needed
 *   - Backward compatible: old coordinate-only macros still work
 *   - New macros store both semantic + coordinate (dual encoding)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, exec } = require('child_process');

// Phase 2: Semantic action support
const axGrounding = require('./ax-grounding');
const semanticConverter = require('./semantic-action-converter');

// Phase 3+4 modules
const { initSearchIndex, indexMacro: fts5Index, removeFromIndex, rebuildIndex, searchFTS5, searchMacrosEnhanced, recordExecution, getRecentMacros, getLastExecutedMacroId } = require('./fts5-search');
const { findElementByVision, getTier3Stats } = require('./vision-fallback');
const { extractVariables, suggestVariables, parameterizeMacro, prepareForReplay } = require('./macro-variables');
const { generateMacroNameLLM } = require('./llm-naming');


// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MACROS_DIR = '/tmp/capy-macros';
const CLICLICK = '/opt/homebrew/bin/cliclick';
const SCREENCAPTURE = '/usr/sbin/screencapture';

// ---------------------------------------------------------------------------
// SSE Event Bus (same pattern as voice-assistant.js overlayClients)
// ---------------------------------------------------------------------------
const macroClients = new Set();

// Cross-bus: forward recording events to overlay SSE (set by server.js)
let overlayEmitter = null;
function setOverlayEmitter(fn) { overlayEmitter = fn; }

function emitMacroEvent(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const c of macroClients) {
    try { c.write(msg); } catch (e) { macroClients.delete(c); }
  }
  // Forward recording/replay events to overlay so voice-overlay.html can update UI
  if (overlayEmitter && ['recording_started', 'recording_step', 'recording_stopped', 'replay_started', 'replay_progress', 'replay_complete', 'replay_error'].includes(data.type)) {
    overlayEmitter(data);
  }
}

function handleMacroStream(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  macroClients.add(res);
  console.log(`[Macro] SSE client connected (${macroClients.size} total)`);

  // Initial sync
  res.write(`data: ${JSON.stringify({ type: 'idle', isRecording })}\n\n`);

  // Keepalive (15s < Cloudflare 100s timeout)
  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch (e) { clearInterval(keepalive); }
  }, 15000);

  req.on('close', () => {
    macroClients.delete(res);
    clearInterval(keepalive);
    console.log(`[Macro] SSE client disconnected (${macroClients.size} remaining)`);
  });
}

// ---------------------------------------------------------------------------
// Recording State
// ---------------------------------------------------------------------------
let isRecording = false;
let currentRecording = null; // { id, startTime, steps: [], screenshotsDir }

function generateId() {
  return 'macro-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
}

// ---------------------------------------------------------------------------
// Screenshot Helpers
// ---------------------------------------------------------------------------
function captureScreenshot(outputPath) {
  try {
    execSync(`${SCREENCAPTURE} -x -t jpg "${outputPath}" 2>/dev/null`, { timeout: 5000, stdio: 'pipe' });
    // Compress to reasonable size (quality 60)
    try {
      execSync(`sips -s formatOptions 60 "${outputPath}" 2>/dev/null`, { timeout: 5000, stdio: 'pipe' });
    } catch (e) {}
    return true;
  } catch (e) {
    console.error(`[Macro] Screenshot capture failed: ${e.message}`);
    return false;
  }
}

function getMousePosition() {
  try {
    const output = execSync(`${CLICLICK} p`, { timeout: 3000, stdio: 'pipe' }).toString().trim();
    // Output format: "x,y" e.g., "500,300"
    const [x, y] = output.split(',').map(Number);
    if (!isNaN(x) && !isNaN(y)) return { x, y };
  } catch (e) {
    console.error(`[Macro] Mouse position failed: ${e.message}`);
  }
  return null;
}

function getActiveApp() {
  try {
    const output = execSync(
      `osascript -e 'tell application "System Events" to get {name, bundle identifier} of first application process whose frontmost is true'`,
      { timeout: 3000, stdio: 'pipe' }
    ).toString().trim();
    // Output: "AppName, com.bundle.id"
    const parts = output.split(', ');
    return { name: parts[0] || 'Unknown', bundleId: parts[1] || '' };
  } catch (e) {
    return { name: 'Unknown', bundleId: '' };
  }
}

function getActiveWindowTitle() {
  try {
    const output = execSync(
      `osascript -e 'tell application "System Events" to get name of front window of first application process whose frontmost is true'`,
      { timeout: 3000, stdio: 'pipe' }
    ).toString().trim();
    return output;
  } catch (e) {
    return '';
  }
}

function hashFile(filepath) {
  try {
    const data = fs.readFileSync(filepath);
    return crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
  } catch (e) {
    return crypto.randomBytes(8).toString('hex');
  }
}

// ---------------------------------------------------------------------------
// Storage Helpers
// ---------------------------------------------------------------------------
function ensureMacrosDir() {
  if (!fs.existsSync(MACROS_DIR)) {
    fs.mkdirSync(MACROS_DIR, { recursive: true });
  }
}

function getMacroDirs() {
  ensureMacrosDir();
  try {
    return fs.readdirSync(MACROS_DIR)
      .filter(d => {
        const manifestPath = path.join(MACROS_DIR, d, 'manifest.json');
        return fs.existsSync(manifestPath);
      })
      .sort((a, b) => {
        // Sort by modification time, newest first
        const aTime = fs.statSync(path.join(MACROS_DIR, a, 'manifest.json')).mtimeMs;
        const bTime = fs.statSync(path.join(MACROS_DIR, b, 'manifest.json')).mtimeMs;
        return bTime - aTime;
      });
  } catch (e) {
    return [];
  }
}

function loadManifest(macroId) {
  const manifestPath = path.join(MACROS_DIR, macroId, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (e) {
    return null;
  }
}

function saveManifest(macroId, manifest) {
  const dir = path.join(MACROS_DIR, macroId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  // Phase 3: Index in FTS5 search
  try { fts5Index(manifest); } catch(e) { console.warn('[FTS5] Index failed:', e.message); }
}

function storeScreenshot(macroId, screenshotPath) {
  const dir = path.join(MACROS_DIR, macroId, 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  const hash = hashFile(screenshotPath);
  const dest = path.join(dir, `${hash}.jpg`);
  if (!fs.existsSync(dest)) {
    fs.copyFileSync(screenshotPath, dest);
  }
  return hash;
}

function storeScreenshotFromBase64(macroId, base64Data) {
  const dir = path.join(MACROS_DIR, macroId, 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  const buffer = Buffer.from(base64Data, 'base64');
  const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  const dest = path.join(dir, `${hash}.jpg`);
  if (!fs.existsSync(dest)) {
    fs.writeFileSync(dest, buffer);
  }
  return hash;
}

// ---------------------------------------------------------------------------
// Auto-Naming
// ---------------------------------------------------------------------------
function autoGenerateName(steps) {
  if (!steps || steps.length === 0) return 'Untitled Macro';

  // Extract app names
  const apps = new Set();
  steps.forEach(s => {
    if (s.axContext?.app) {
      const name = s.axContext.appName || s.axContext.app.split('.').pop() || '';
      if (name) apps.add(name);
    }
  });

  // Extract key actions
  const actions = [];
  for (const step of steps.slice(0, 8)) {
    if (step.type === 'click' && step.axContext?.element?.title) {
      actions.push(`Click ${step.axContext.element.title}`);
    } else if (step.type === 'text_input' && step.text) {
      const preview = step.text.slice(0, 20) + (step.text.length > 20 ? '...' : '');
      actions.push(`Type "${preview}"`);
    } else if (step.type === 'key_combo') {
      actions.push(`${(step.modifiers || []).join('+')}+${step.key || step.keyCode}`);
    }
  }

  const appStr = apps.size > 0 ? Array.from(apps).slice(0, 2).join(', ') : 'Desktop';
  const actionStr = actions.length > 0 ? ': ' + actions.slice(0, 3).join(' > ') : '';

  return `${appStr}${actionStr}`;
}

// ---------------------------------------------------------------------------
// Search / Fuzzy Match
// ---------------------------------------------------------------------------
function fuzzyMatch(query, text) {
  if (!query || !text) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  // Exact substring match
  if (t.includes(q)) return 1.0;

  // Word-level matching
  const queryWords = q.split(/\s+/);
  const textWords = t.split(/\s+/);
  let matched = 0;
  for (const qw of queryWords) {
    if (textWords.some(tw => tw.includes(qw) || qw.includes(tw))) matched++;
  }
  if (queryWords.length > 0) {
    const wordScore = matched / queryWords.length;
    if (wordScore > 0) return 0.5 + wordScore * 0.4;
  }

  // Character-level (Jaro-like)
  let j = 0;
  for (let i = 0; i < q.length; i++) {
    while (j < t.length && t[j] !== q[i]) j++;
    if (j >= t.length) break;
    j++;
  }
  return (j < t.length ? 0.3 : 0.1) * (q.length / Math.max(q.length, t.length));
}

function searchMacros(query) {
  const dirs = getMacroDirs();
  const results = [];

  for (const dir of dirs) {
    const manifest = loadManifest(dir);
    if (!manifest) continue;

    const nameScore = fuzzyMatch(query, manifest.name || '');
    const descScore = fuzzyMatch(query, manifest.description || '') * 0.8;
    const tagScore = (manifest.tags || []).reduce((best, tag) =>
      Math.max(best, fuzzyMatch(query, tag)), 0) * 0.9;
    const appScore = fuzzyMatch(query, manifest.appContext || '') * 0.7;

    const score = Math.max(nameScore, descScore, tagScore, appScore);
    if (score > 0.2) {
      results.push({ ...manifest, _score: score, _dir: dir });
    }
  }

  // Sort by score descending, then by lastUsed descending
  results.sort((a, b) => {
    if (Math.abs(a._score - b._score) > 0.1) return b._score - a._score;
    return (b.lastUsed || 0) - (a.lastUsed || 0);
  });

  return results;
}

// ---------------------------------------------------------------------------
// Intelligent Replay Engine
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Tier 2: AX Element Matching via JXA
// ---------------------------------------------------------------------------

// Map AX roles to JXA UI element collections
const AX_ROLE_TO_JXA = {
  'AXButton': 'buttons',
  'AXTextField': 'textFields',
  'AXTextArea': 'textAreas',
  'AXStaticText': 'staticTexts',
  'AXLink': 'links',
  'AXImage': 'images',
  'AXCheckBox': 'checkboxes',
  'AXRadioButton': 'radioButtons',
  'AXPopUpButton': 'popUpButtons',
  'AXMenuItem': 'menuItems',
  'AXComboBox': 'comboBoxes',
  'AXSlider': 'sliders',
  'AXTabGroup': 'tabGroups',
  'AXTable': 'tables',
  'AXToolbar': 'toolbars',
  'AXGroup': 'groups',
  'AXScrollArea': 'scrollAreas',
};

/**
 * Find a UI element by its recorded AX context.
 * Uses JXA (JavaScript for Automation) to search the frontmost app's AX tree.
 *
 * Search strategy:
 *   1. Exact match: role + title in the target app
 *   2. Fuzzy match: role + substring title match
 *   3. Role-only: find all elements of that role, pick closest to recorded position
 *
 * @param {object} axContext - Recorded AX context { app, appName, element: { role, title, position, size } }
 * @returns {{ found: boolean, position?: {x,y}, confidence: number, method: string }}
 */
function findElementByAX(axContext) {
  if (!axContext || !axContext.element) {
    return { found: false, confidence: 0, method: 'none' };
  }

  const { element } = axContext;
  const appName = axContext.appName || '';
  const role = element.role || '';
  const title = element.title || '';
  const jxaCollection = AX_ROLE_TO_JXA[role];

  if (!appName || !role) {
    return { found: false, confidence: 0, method: 'missing_data' };
  }

  // Strategy 1: Exact title match via JXA
  if (title && jxaCollection) {
    const result = jxaSearchElement(appName, jxaCollection, title, true);
    if (result.found) {
      console.log(`[Replay] Tier 2 exact match: ${role} "${title}" in ${appName} at (${result.position.x},${result.position.y})`);
      return { ...result, confidence: 0.95, method: 'exact_title' };
    }
  }

  // Strategy 2: Substring title match
  if (title && title.length >= 3 && jxaCollection) {
    const result = jxaSearchElement(appName, jxaCollection, title, false);
    if (result.found) {
      console.log(`[Replay] Tier 2 fuzzy match: ${role} containing "${title}" in ${appName} at (${result.position.x},${result.position.y})`);
      return { ...result, confidence: 0.75, method: 'fuzzy_title' };
    }
  }

  // Strategy 3: Role-only search — find closest to recorded position
  if (jxaCollection && element.position) {
    const result = jxaFindClosestByRole(appName, jxaCollection, element.position);
    if (result.found) {
      console.log(`[Replay] Tier 2 role+proximity match: ${role} near (${element.position.x},${element.position.y}) -> (${result.position.x},${result.position.y})`);
      return { ...result, confidence: 0.5, method: 'role_proximity' };
    }
  }

  return { found: false, confidence: 0, method: 'not_found' };
}

/**
 * Search for a UI element by title using recursive AX tree traversal.
 * Searches through groups, toolbars, split groups, etc. — not just top-level.
 * Returns the element's center position if found.
 */
function jxaSearchElement(appName, collection, title, exact) {
  const safeApp = appName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const safeTitle = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const targetRole = Object.keys(AX_ROLE_TO_JXA).find(k => AX_ROLE_TO_JXA[k] === collection) || '';

  const jxa = `
    (() => {
      const se = Application("System Events");
      let procs;
      try { procs = se.processes.whose({name: "${safeApp}"}); } catch(e) { return JSON.stringify({found: false}); }
      if (procs.length === 0) return JSON.stringify({found: false});
      const proc = procs[0];
      const wins = proc.windows();
      if (wins.length === 0) return JSON.stringify({found: false});

      const containers = ["AXGroup", "AXToolbar", "AXSplitGroup", "AXTabGroup", "AXScrollArea"];
      const targetRole = "${targetRole}";
      const targetTitle = "${safeTitle}";
      const exactMatch = ${exact ? 'true' : 'false'};

      function search(el, depth) {
        if (depth > 4) return null;
        try {
          const children = el.uiElements();
          const limit = Math.min(children.length, 50);
          for (let i = 0; i < limit; i++) {
            try {
              const c = children[i];
              const role = c.role();
              if (role === targetRole) {
                const name = c.name() || "";
                const matched = exactMatch ? (name === targetTitle) : (name.indexOf(targetTitle) >= 0);
                if (matched) {
                  const pos = c.position();
                  const sz = c.size();
                  return {
                    found: true,
                    x: pos[0] + Math.floor(sz[0] / 2),
                    y: pos[1] + Math.floor(sz[1] / 2),
                    name: name, w: sz[0], h: sz[1]
                  };
                }
              }
              if (containers.indexOf(role) >= 0) {
                const sub = search(c, depth + 1);
                if (sub) return sub;
              }
            } catch(e) { continue; }
          }
        } catch(e) {}
        return null;
      }

      for (let w = 0; w < wins.length; w++) {
        const result = search(wins[w], 0);
        if (result) return JSON.stringify(result);
      }
      return JSON.stringify({found: false});
    })()
  `.trim();

  const tmpScript = `/tmp/capy-jxa-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.js`;
  try {
    fs.writeFileSync(tmpScript, jxa);
    const output = execSync(`osascript -l JavaScript "${tmpScript}"`, {
      timeout: 2000,
      stdio: 'pipe',
    }).toString().trim();

    const result = JSON.parse(output);
    if (result.found) {
      return { found: true, position: { x: result.x, y: result.y }, size: { w: result.w, h: result.h } };
    }
  } catch (e) {
    console.warn(`[Replay] JXA search failed for ${collection} "${title}": ${e.message.slice(0, 100)}`);
  } finally {
    try { fs.unlinkSync(tmpScript); } catch (e) {}
  }

  return { found: false };
}

/**
 * Find the closest element of a given role to a recorded position.
 * Recursive AX tree search through all container elements.
 */
function jxaFindClosestByRole(appName, collection, recordedPos) {
  const safeApp = appName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const targetRole = Object.keys(AX_ROLE_TO_JXA).find(k => AX_ROLE_TO_JXA[k] === collection) || '';

  const jxa = `
    (() => {
      const se = Application("System Events");
      let procs;
      try { procs = se.processes.whose({name: "${safeApp}"}); } catch(e) { return JSON.stringify({found: false}); }
      if (procs.length === 0) return JSON.stringify({found: false});
      const proc = procs[0];
      const wins = proc.windows();
      if (wins.length === 0) return JSON.stringify({found: false});

      const containers = ["AXGroup", "AXToolbar", "AXSplitGroup", "AXTabGroup", "AXScrollArea"];
      const targetRole = "${targetRole}";
      const tx = ${recordedPos.x}, ty = ${recordedPos.y};
      let best = null, bestDist = Infinity;

      function search(el, depth) {
        if (depth > 4) return;
        try {
          const children = el.uiElements();
          const limit = Math.min(children.length, 50);
          for (let i = 0; i < limit; i++) {
            try {
              const c = children[i];
              const role = c.role();
              if (role === targetRole) {
                const pos = c.position();
                const sz = c.size();
                const cx = pos[0] + sz[0] / 2;
                const cy = pos[1] + sz[1] / 2;
                const dist = Math.sqrt((cx - tx) * (cx - tx) + (cy - ty) * (cy - ty));
                if (dist < bestDist) {
                  bestDist = dist;
                  const nm = (function() { try { return c.name(); } catch(e) { return ""; } })();
                  best = {x: Math.floor(cx), y: Math.floor(cy), w: sz[0], h: sz[1], name: nm, dist: Math.floor(dist)};
                }
              }
              if (containers.indexOf(role) >= 0) {
                search(c, depth + 1);
              }
            } catch(e) { continue; }
          }
        } catch(e) {}
      }

      for (let w = 0; w < wins.length; w++) {
        search(wins[w], 0);
      }

      if (best && bestDist < 300) {
        return JSON.stringify({found: true, ...best});
      }
      return JSON.stringify({found: false});
    })()
  `.trim();

  const tmpScript = `/tmp/capy-jxa-prox-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.js`;
  try {
    fs.writeFileSync(tmpScript, jxa);
    const output = execSync(`osascript -l JavaScript "${tmpScript}"`, {
      timeout: 2000,
      stdio: 'pipe',
    }).toString().trim();

    const result = JSON.parse(output);
    if (result.found) {
      return { found: true, position: { x: result.x, y: result.y }, size: { w: result.w, h: result.h } };
    }
  } catch (e) {
    console.warn(`[Replay] JXA proximity search failed for ${collection}: ${e.message.slice(0, 100)}`);
  } finally {
    try { fs.unlinkSync(tmpScript); } catch (e) {}
  }

  return { found: false };
}

// ---------------------------------------------------------------------------
// Screen-Settle Wait (dHash-based)
// ---------------------------------------------------------------------------

/**
 * Compute a perceptual hash (dHash) of a screenshot.
 * Uses sips to resize to 9x8 grayscale, then compares adjacent pixels.
 * Returns a 64-bit hash as a BigInt.
 */
function computeScreenHash() {
  const tmpFile = `/tmp/capy-settle-${Date.now()}.jpg`;
  const resizedFile = `/tmp/capy-settle-small-${Date.now()}.bmp`;
  try {
    // Capture screenshot
    execSync(`${SCREENCAPTURE} -x -t jpg "${tmpFile}" 2>/dev/null`, { timeout: 3000, stdio: 'pipe' });

    // Resize to 9x8 via sips (built-in macOS tool)
    execSync(`sips -z 8 9 -s format bmp "${tmpFile}" --out "${resizedFile}" 2>/dev/null`, {
      timeout: 3000, stdio: 'pipe'
    });

    // Read the raw BMP pixel data and compute dHash
    const data = fs.readFileSync(resizedFile);
    // BMP header is typically 54 bytes for 24-bit BMP, pixel data follows
    const headerSize = data.readUInt32LE(10); // Offset to pixel data
    const pixels = data.slice(headerSize);

    // Convert to grayscale values (BMP stores BGR)
    const gray = [];
    for (let i = 0; i < Math.min(pixels.length, 72 * 3); i += 3) {
      // BMP rows are bottom-to-top, but for dHash row order doesn't matter
      const b = pixels[i] || 0;
      const g = pixels[i + 1] || 0;
      const r = pixels[i + 2] || 0;
      gray.push(Math.round(0.299 * r + 0.587 * g + 0.114 * b));
    }

    // Compute dHash: compare adjacent horizontal pixels
    // 9 wide x 8 tall -> 8 comparisons per row -> 64 bits
    let hash = BigInt(0);
    let bit = 0;
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const idx = row * 9 + col;
        if (idx + 1 < gray.length && gray[idx] < gray[idx + 1]) {
          hash |= BigInt(1) << BigInt(bit);
        }
        bit++;
      }
    }
    return hash;
  } catch (e) {
    return BigInt(-1); // Signal failure
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (e) {}
    try { fs.unlinkSync(resizedFile); } catch (e) {}
  }
}

/**
 * Hamming distance between two 64-bit hashes.
 */
function hammingDistance(a, b) {
  if (a < BigInt(0) || b < BigInt(0)) return 99; // Signal failure
  let xor = a ^ b;
  let count = 0;
  while (xor > BigInt(0)) {
    count += Number(xor & BigInt(1));
    xor >>= BigInt(1);
  }
  return count;
}

/**
 * Wait for the screen to settle (stop changing) by polling dHash.
 * Two consecutive captures with hamming distance <=5 = "settled".
 *
 * @param {number} maxWaitMs - Maximum wait time (default 5000ms)
 * @param {number} pollIntervalMs - Polling interval (default 200ms)
 * @returns {{ settled: boolean, elapsed: number, polls: number }}
 */
async function waitForScreenSettle(maxWaitMs = 5000, pollIntervalMs = 200) {
  const start = Date.now();
  let prevHash = computeScreenHash();
  let polls = 1;

  while (Date.now() - start < maxWaitMs) {
    await sleep(pollIntervalMs);
    const currentHash = computeScreenHash();
    polls++;

    if (hammingDistance(prevHash, currentHash) <= 5) {
      return { settled: true, elapsed: Date.now() - start, polls };
    }
    prevHash = currentHash;
  }

  console.warn(`[Replay] Screen did not settle within ${maxWaitMs}ms (${polls} polls)`);
  return { settled: false, elapsed: Date.now() - start, polls };
}

function simulateClick(x, y, button = 'left') {
  const flag = button === 'right' ? 'rc' : 'c';
  try {
    execSync(`${CLICLICK} ${flag}:${Math.round(x)},${Math.round(y)}`, { timeout: 3000, stdio: 'pipe' });
    return true;
  } catch (e) {
    console.error(`[Macro] Click simulation failed at (${x},${y}): ${e.message}`);
    return false;
  }
}

function simulateDoubleClick(x, y) {
  try {
    execSync(`${CLICLICK} dc:${Math.round(x)},${Math.round(y)}`, { timeout: 3000, stdio: 'pipe' });
    return true;
  } catch (e) {
    return false;
  }
}

function simulateType(text) {
  try {
    // cliclick t: types text character by character
    // For longer text, use pbcopy + cmd+v (faster and handles special chars)
    if (text.length > 10) {
      // Use clipboard for long text
      execSync(`echo -n ${JSON.stringify(text)} | pbcopy`, { timeout: 3000, stdio: 'pipe' });
      execSync(`${CLICLICK} kp:cmd+v`, { timeout: 3000, stdio: 'pipe' });
    } else {
      execSync(`${CLICLICK} t:${text}`, { timeout: 3000, stdio: 'pipe' });
    }
    return true;
  } catch (e) {
    console.error(`[Macro] Type simulation failed: ${e.message}`);
    return false;
  }
}

function simulateKeyCombo(key, modifiers = []) {
  try {
    // cliclick kp: format: modifier+key, e.g., "cmd+c", "cmd+shift+s"
    const combo = [...modifiers, key].join('+');
    execSync(`${CLICLICK} kp:${combo}`, { timeout: 3000, stdio: 'pipe' });
    return true;
  } catch (e) {
    console.error(`[Macro] Key combo simulation failed (${key}): ${e.message}`);
    return false;
  }
}

function simulateScroll(deltaX, deltaY) {
  try {
    // AppleScript scroll (cliclick doesn't support scroll natively)
    const direction = deltaY < 0 ? 'up' : 'down';
    const amount = Math.abs(deltaY || 3);
    execSync(
      `osascript -e 'tell application "System Events" to scroll ${direction === "up" ? "up" : "down"} ${amount}'`,
      { timeout: 3000, stdio: 'pipe' }
    );
    return true;
  } catch (e) {
    // Fallback: use cliclick with mouse scroll if available
    return false;
  }
}

async function replayMacro(macroId, options = {}) {
  const manifest = loadManifest(macroId);
  if (!manifest) throw new Error(`Macro not found: ${macroId}`);

  const { onStep, speedMultiplier = 1.0 } = options;
  const steps = manifest.steps || [];
  const results = [];
  let coordinatesUpdated = false;

  console.log(`[Macro] Replaying "${manifest.name}" (${steps.length} steps, intelligent mode)`);

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const prevStep = i > 0 ? steps[i - 1] : null;

    // Inter-step delay (preserve recorded timing)
    if (prevStep) {
      const delay = (step.timestamp - prevStep.timestamp) * 1000;
      const adjustedDelay = Math.max(100, Math.min(delay / speedMultiplier, 5000));
      await sleep(adjustedDelay);
    }

    // Screen-settle wait before click steps (skip for typing/key combos)
    const needsSettle = ['click', 'double_click', 'scroll'].includes(step.type);
    let settleResult = null;
    if (needsSettle && i > 0) {
      settleResult = await waitForScreenSettle(5000, 200);
      if (!settleResult.settled) {
        console.warn(`[Replay] Step ${i}: screen did not settle (${settleResult.elapsed}ms)`);
      }
    }

    // Determine click target (Phase 2: NEW tier system)
    // Tier 0: Semantic AX search (NEW - Phase 2)
    // Tier 1: Legacy coordinates (baseline)
    // Tier 2: AX JXA matching (existing)
    // Tier 3: Vision AI fallback (existing)
    let tier = 1;
    let targetPos = step.position ? { ...step.position } : null;
    let axResult = null;

    if (['click', 'double_click'].includes(step.type)) {
      // Phase 2: Try Tier 0 - Semantic AX search FIRST
      if (step.target) {
        try {
          const semanticResult = await resolveSemanticAction(step);
          if (semanticResult) {
            tier = 0;
            const oldPos = targetPos ? `(${targetPos.x},${targetPos.y})` : 'none';
            targetPos = { x: semanticResult.x, y: semanticResult.y };
            axResult = semanticResult;
            console.log(`[Replay] Step ${i}: Tier 0 semantic ${semanticResult.method} -> (${targetPos.x},${targetPos.y}) (was ${oldPos})`);

            // Self-healing: update step coordinates for future replays
            if (step.position &&
                (Math.abs(step.position.x - targetPos.x) > 5 || Math.abs(step.position.y - targetPos.y) > 5)) {
              if (!step.coordinateHistory) step.coordinateHistory = [];
              step.coordinateHistory.push({
                position: { ...step.position },
                updatedAt: new Date().toISOString(),
              });
              step.position = { ...targetPos };
              coordinatesUpdated = true;
            }
          } else {
            console.log(`[Replay] Step ${i}: Tier 0 semantic search failed, trying Tier 2...`);
          }
        } catch (e) {
          console.warn(`[Replay] Tier 0 semantic error: ${e.message}`);
        }
      }

      // Try Tier 2: AX JXA element matching (if Tier 0 failed)
      if (tier === 1 && step.axContext) {
        axResult = findElementByAX(step.axContext);
        if (axResult.found) {
          tier = 2;
          const oldPos = targetPos ? `(${targetPos.x},${targetPos.y})` : 'none';
          targetPos = axResult.position;
          console.log(`[Replay] Step ${i}: Tier 2 ${axResult.method} -> (${targetPos.x},${targetPos.y}) (was ${oldPos})`);

          // Self-healing: update step coordinates for future replays
          if (step.position &&
              (Math.abs(step.position.x - targetPos.x) > 5 || Math.abs(step.position.y - targetPos.y) > 5)) {
            if (!step.coordinateHistory) step.coordinateHistory = [];
            step.coordinateHistory.push({
              position: { ...step.position },
              updatedAt: new Date().toISOString(),
            });
            step.position = { ...targetPos };
            coordinatesUpdated = true;
          }
        } else {
          console.log(`[Replay] Step ${i}: Tier 2 miss (${axResult.method}), trying Tier 3 vision...`);
        }
      }

      // Try Tier 3: Vision AI fallback (if Tier 0 and Tier 2 failed)
      if (tier === 1) {
        const AI_KEY = process.env.AI_GATEWAY_KEY || 'cc00f875633a4dca884e24f5ab6e0106';
        try {
          const visionResult = await findElementByVision(step, macroId, AI_KEY);
          if (visionResult.found) {
            tier = 3;
            targetPos = visionResult.position;
            axResult = visionResult;
            console.log(`[Replay] Step ${i}: Tier 3 vision -> (${targetPos.x},${targetPos.y}) conf=${visionResult.confidence}`);
            // Self-healing: update step coordinates
            if (step.position && (Math.abs(step.position.x - targetPos.x) > 5 || Math.abs(step.position.y - targetPos.y) > 5)) {
              if (!step.coordinateHistory) step.coordinateHistory = [];
              step.coordinateHistory.push({ position: { ...step.position }, updatedAt: new Date().toISOString() });
              step.position = { ...targetPos };
              coordinatesUpdated = true;
            }
          } else {
            console.log(`[Replay] Step ${i}: Tier 3 miss (conf=${visionResult.confidence}), using Tier 1 coordinates`);
          }
        } catch(e) { console.warn(`[Replay] Tier 3 error: ${e.message}`); }
      }
    }

    // Report progress with tier info
    const progress = {
      step: i,
      total: steps.length,
      type: step.type,
      description: stepDescription(step),
      tier,
      elementFound: axResult ? axResult.found : null,
      confidence: axResult ? axResult.confidence : null,
      settled: settleResult ? settleResult.settled : null,
      settleMs: settleResult ? settleResult.elapsed : null,
    };
    if (onStep) onStep(progress);
    emitMacroEvent({ type: 'replay_progress', macroId, ...progress });

    // Execute step
    let success = false;
    switch (step.type) {
      case 'click':
        if (targetPos) {
          success = simulateClick(targetPos.x, targetPos.y, step.button || 'left');
        }
        break;
      case 'double_click':
        if (targetPos) {
          success = simulateDoubleClick(targetPos.x, targetPos.y);
        }
        break;
      case 'text_input':
        success = simulateType(step.text || '');
        break;
      case 'key_combo':
      case 'keypress':
        success = simulateKeyCombo(step.key || '', step.modifiers || []);
        break;
      case 'scroll':
        success = simulateScroll(step.deltaX || 0, step.deltaY || 0);
        break;
      default:
        console.warn(`[Macro] Unknown step type: ${step.type}`);
        success = true;
    }

    results.push({ step: i, type: step.type, success, tier });

    if (!success) {
      console.error(`[Macro] Step ${i} failed: ${step.type} (tier ${tier})`);
    }

    // Small delay after each action for UI to respond
    await sleep(150);
  }

  // Update usage stats
  manifest.lastUsed = Date.now();
  manifest.useCount = (manifest.useCount || 0) + 1;

  // Self-healing: save updated coordinates if replay was mostly successful
  const successRate = results.filter(r => r.success).length / Math.max(results.length, 1);
  if (coordinatesUpdated && successRate >= 0.8) {
    manifest.lastCoordinateUpdate = new Date().toISOString();
    console.log(`[Replay] Self-healing: coordinates updated (${(successRate * 100).toFixed(0)}% success rate)`);
  } else if (coordinatesUpdated) {
    // Revert coordinate changes if replay was too broken
    console.log(`[Replay] Skipping self-healing: only ${(successRate * 100).toFixed(0)}% success rate`);
    // Reload original manifest to discard in-memory changes
    const original = loadManifest(macroId);
    if (original) {
      manifest.steps = original.steps;
    }
  }

  saveManifest(macroId, manifest);

  // Phase 3+4: Track execution for recency/context ranking
  try { recordExecution(macroId, manifest.name); } catch(e) {}

  // Phase 2: Track semantic matching stats
  const tier0Count = results.filter(r => r.tier === 0).length;
  const tier2Count = results.filter(r => r.tier === 2).length;
  const tier3Count = results.filter(r => r.tier === 3).length;

  return {
    success: results.every(r => r.success),
    stepsExecuted: results.length,
    stepsSucceeded: results.filter(r => r.success).length,
    stepsFailed: results.filter(r => !r.success).length,
    tier0Matches: tier0Count,  // Phase 2: Semantic AX matches
    tier2Matches: tier2Count,
    tier3Matches: tier3Count,
    coordinatesHealed: coordinatesUpdated && successRate >= 0.8,
    results,
  };
}

function stepDescription(step) {
  switch (step.type) {
    case 'click':
      // Phase 2: Show semantic target if available
      if (step.target && step.target.label) {
        return `Click ${step.target.role}[${step.target.label}]`;
      }
      const label = step.axContext?.element?.title || `(${step.position?.x},${step.position?.y})`;
      return `Click ${label}`;
    case 'double_click':
      if (step.target && step.target.label) {
        return `Double-click ${step.target.role}[${step.target.label}]`;
      }
      return `Double-click (${step.position?.x},${step.position?.y})`;
    case 'text_input':
      return `Type "${(step.text || '').slice(0, 30)}"`;
    case 'key_combo':
    case 'keypress':
      return `Press ${(step.modifiers || []).concat(step.key || '').join('+')}`;
    case 'scroll':
      return `Scroll ${step.deltaY > 0 ? 'down' : 'up'}`;
    default:
      return step.type;
  }
}

// ---------------------------------------------------------------------------
// Phase 2: Semantic Action Capture
// ---------------------------------------------------------------------------

/**
 * Capture semantic action at given coordinates.
 * Queries AX tree, extracts role/label/path for semantic replay.
 * Returns null if no AX element found (fallback to coordinate-only).
 *
 * @param {number} x - Click X coordinate
 * @param {number} y - Click Y coordinate
 * @param {string} actionType - Action type ('click', 'type', etc.)
 * @returns {Promise<object|null>} - SemanticAction or null
 */
async function captureSemanticAction(x, y, actionType) {
  try {
    const semantic = await semanticConverter.coordinateToSemantic(x, y, actionType);
    return semantic;
  } catch (error) {
    console.warn(`[Macro] Semantic capture failed: ${error.message}`);
    return null;
  }
}

/**
 * Resolve semantic action to current coordinates.
 * Searches AX tree, returns current position of element.
 * Returns null if element not found (fallback to stored coordinates).
 *
 * @param {object} step - Step with semantic target
 * @returns {Promise<object|null>} - {x, y, confidence, method} or null
 */
async function resolveSemanticAction(step) {
  if (!step.target) {
    return null;
  }

  try {
    const coords = await semanticConverter.semanticToCoordinate({
      type: step.type,
      target: step.target,
      coordinates: step.position ? [step.position.x, step.position.y] : [0, 0],
    });
    return coords;
  } catch (error) {
    console.warn(`[Macro] Semantic resolution failed: ${error.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Route Mounting
// ---------------------------------------------------------------------------
function mountMacroRecorderRoutes(app) {

  // -----------------------------------------------------------
  // RECORD START
  // -----------------------------------------------------------
  app.post('/macro/record/start', (req, res) => {
    if (isRecording) {
      return res.status(409).json({ error: 'Already recording. Stop current recording first.' });
    }

    const id = generateId();
    const macroDir = path.join(MACROS_DIR, id);
    const screenshotsDir = path.join(macroDir, 'screenshots');
    fs.mkdirSync(screenshotsDir, { recursive: true });

    // BUG-14 FIX: Store name from START request (not just STOP)
    const { name } = req.body || {};

    currentRecording = {
      id,
      name: name || null,
      startTime: Date.now(),
      steps: [],
      screenshotsDir,
      macroDir,
    };
    isRecording = true;

    console.log(`[Macro] Recording started: ${id}${name ? ` (name: "${name}")` : ''}`);
    emitMacroEvent({ type: 'recording_started', macroId: id });

    res.json({ success: true, macroId: id, message: 'Recording started' });
  });

  // -----------------------------------------------------------
  // RECORD EVENT - Accept a single event during recording
  // -----------------------------------------------------------
  app.post('/macro/record/event', async (req, res) => {
    if (!isRecording || !currentRecording) {
      return res.status(409).json({ error: 'Not recording' });
    }

    const {
      type, position, button, modifiers, key, keyCode, characters,
      text, deltaX, deltaY, screenshotBase64, axContext
    } = req.body;

    if (!type) return res.status(400).json({ error: 'event type required' });

    const step = {
      id: currentRecording.steps.length,
      type,
      timestamp: (Date.now() - currentRecording.startTime) / 1000, // seconds since start
    };

    // Position (for click/drag events)
    if (position) step.position = position;
    if (button) step.button = button;
    if (modifiers) step.modifiers = modifiers;

    // Keyboard
    if (key) step.key = key;
    if (keyCode !== undefined) step.keyCode = keyCode;
    if (characters) step.characters = characters;
    if (text) step.text = text;

    // Scroll
    if (deltaX !== undefined) step.deltaX = deltaX;
    if (deltaY !== undefined) step.deltaY = deltaY;

    // Phase 2: Capture semantic action for click/type events
    if (position && ['click', 'double_click', 'right_click'].includes(type)) {
      try {
        const semantic = await captureSemanticAction(position.x, position.y, type);
        if (semantic) {
          step.target = semantic.target;
          step.semanticConfidence = semantic.confidence;
          console.log(`[Macro] Semantic capture: ${semantic.target.role}[${semantic.target.label}] (conf: ${semantic.confidence.toFixed(2)})`);
        }
      } catch (e) {
        console.warn(`[Macro] Semantic capture error: ${e.message}`);
      }
    }

    // AX context (legacy, kept for backward compatibility)
    if (axContext) step.axContext = axContext;

    // Screenshot (base64 from Swift, or capture now)
    if (screenshotBase64) {
      step.screenshotHash = storeScreenshotFromBase64(currentRecording.id, screenshotBase64);
    }

    currentRecording.steps.push(step);

    const stepCount = currentRecording.steps.length;
    emitMacroEvent({
      type: 'recording_step',
      stepCount,
      lastAction: stepDescription(step),
    });

    console.log(`[Macro] Event recorded: ${type} (step ${stepCount})`);
    res.json({ success: true, stepId: step.id, stepCount, semantic: !!step.target });
  });

  // -----------------------------------------------------------
  // RECORD CAPTURE - Capture current screen state as a step
  // (Phase 1 helper: takes screenshot + gets mouse position)
  // -----------------------------------------------------------
  app.post('/macro/record/capture', async (req, res) => {
    if (!isRecording || !currentRecording) {
      return res.status(409).json({ error: 'Not recording' });
    }

    const { type = 'click', text, key, modifiers } = req.body;

    // Get current state
    const mousePos = getMousePosition();
    const activeApp = getActiveApp();
    const windowTitle = getActiveWindowTitle();

    // Capture screenshot
    const tmpScreenshot = `/tmp/capy-macro-capture-${Date.now()}.jpg`;
    captureScreenshot(tmpScreenshot);
    let screenshotHash = null;
    if (fs.existsSync(tmpScreenshot)) {
      screenshotHash = storeScreenshot(currentRecording.id, tmpScreenshot);
      try { fs.unlinkSync(tmpScreenshot); } catch (e) {}
    }

    const step = {
      id: currentRecording.steps.length,
      type,
      timestamp: (Date.now() - currentRecording.startTime) / 1000,
      position: mousePos || { x: 0, y: 0 },
      screenshotHash,
      axContext: {
        app: activeApp.bundleId,
        appName: activeApp.name,
        windowTitle,
        element: { role: '', title: '', axPath: '' },
      },
    };

    if (text) step.text = text;
    if (key) step.key = key;
    if (modifiers) step.modifiers = modifiers;

    // Phase 2: Capture semantic action at current mouse position
    if (mousePos && ['click', 'double_click', 'right_click'].includes(type)) {
      try {
        const semantic = await captureSemanticAction(mousePos.x, mousePos.y, type);
        if (semantic) {
          step.target = semantic.target;
          step.semanticConfidence = semantic.confidence;
          console.log(`[Macro] Semantic capture: ${semantic.target.role}[${semantic.target.label}] (conf: ${semantic.confidence.toFixed(2)})`);
        }
      } catch (e) {
        console.warn(`[Macro] Semantic capture error: ${e.message}`);
      }
    }

    currentRecording.steps.push(step);

    const stepCount = currentRecording.steps.length;
    emitMacroEvent({
      type: 'recording_step',
      stepCount,
      lastAction: stepDescription(step),
    });

    console.log(`[Macro] Captured step ${stepCount}: ${type} at (${step.position.x},${step.position.y}) in ${activeApp.name}`);
    res.json({
      success: true,
      stepId: step.id,
      stepCount,
      position: step.position,
      app: activeApp.name,
      windowTitle,
      semantic: !!step.target,
    });
  });

  // -----------------------------------------------------------
  // RECORD STOP
  // -----------------------------------------------------------
  app.post('/macro/record/stop', (req, res) => {
    if (!isRecording || !currentRecording) {
      return res.status(409).json({ error: 'Not recording' });
    }

    const { name: customName } = req.body || {};
    const recording = currentRecording;
    const duration = (Date.now() - recording.startTime) / 1000;

    // BUG-14 FIX: Priority: STOP body name > START body name > auto-generated
    const name = customName || recording.name || autoGenerateName(recording.steps);

    // Extract primary app context
    const appCounts = {};
    recording.steps.forEach(s => {
      const app = s.axContext?.appName || s.axContext?.app || '';
      if (app) appCounts[app] = (appCounts[app] || 0) + 1;
    });
    const primaryApp = Object.entries(appCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';

    // Auto-generate tags
    const tags = new Set();
    if (primaryApp) tags.add(primaryApp.toLowerCase());
    recording.steps.forEach(s => {
      if (s.axContext?.windowTitle) {
        // Extract meaningful words from window titles
        s.axContext.windowTitle.split(/[\s\-\|]+/).forEach(w => {
          if (w.length > 2) tags.add(w.toLowerCase());
        });
      }
    });

    // Build manifest
    const manifest = {
      version: '1.0',
      id: recording.id,
      name,
      description: `${recording.steps.length} steps in ${primaryApp || 'Desktop'}`,
      tags: Array.from(tags).slice(0, 10),
      createdAt: new Date(recording.startTime).toISOString(),
      duration: Math.round(duration * 10) / 10,
      appContext: primaryApp,
      stepCount: recording.steps.length,
      useCount: 0,
      lastUsed: null,
      steps: recording.steps,
    };

    // Save manifest
    // Phase 4: Extract variables
    const suggestedVars = suggestVariables(manifest);
    if (Object.keys(suggestedVars).length > 0) {
      manifest.suggestedVariables = suggestedVars;
      console.log(`[Macro] Detected ${Object.keys(suggestedVars).length} variables: ${Object.keys(suggestedVars).join(', ')}`);
    }

    saveManifest(recording.id, manifest);

    // Phase 4: Try LLM auto-naming (async, non-blocking)
    generateMacroNameLLM(recording.steps).then(llmName => {
      if (llmName && llmName !== manifest.name) {
        manifest.llmName = llmName;
        saveManifest(recording.id, manifest);
        console.log(`[Macro] LLM name: "${llmName}"`);
      }
    }).catch(() => {});

    // Reset state
    isRecording = false;
    currentRecording = null;

    console.log(`[Macro] Recording stopped: "${name}" (${manifest.stepCount} steps, ${manifest.duration}s)`);
    emitMacroEvent({
      type: 'recording_stopped',
      macroId: recording.id,
      name,
      stepCount: manifest.stepCount,
      duration: manifest.duration,
      suggestedName: name,
    });

    res.json({
      success: true,
      macroId: recording.id,
      name,
      stepCount: manifest.stepCount,
      duration: manifest.duration,
    });
  });

  // -----------------------------------------------------------
  // RECORD STATUS
  // -----------------------------------------------------------
  app.get('/macro/record/status', (req, res) => {
    if (!isRecording || !currentRecording) {
      return res.json({ recording: false });
    }
    res.json({
      recording: true,
      macroId: currentRecording.id,
      stepCount: currentRecording.steps.length,
      duration: (Date.now() - currentRecording.startTime) / 1000,
    });
  });

  // -----------------------------------------------------------
  // LIST MACROS
  // -----------------------------------------------------------
  app.get('/macro/list', (req, res) => {
    const { q } = req.query;
    let macros;

    if (q) {
      // Search mode
      macros = searchMacros(q).map(m => ({
        id: m.id,
        name: m.name,
        description: m.description,
        tags: m.tags,
        stepCount: m.stepCount,
        duration: m.duration,
        appContext: m.appContext,
        createdAt: m.createdAt,
        lastUsed: m.lastUsed,
        useCount: m.useCount,
        score: m._score,
      }));
    } else {
      // List all
      macros = getMacroDirs().map(dir => {
        const manifest = loadManifest(dir);
        if (!manifest) return null;
        return {
          id: manifest.id,
          name: manifest.name,
          description: manifest.description,
          tags: manifest.tags,
          stepCount: manifest.stepCount,
          duration: manifest.duration,
          appContext: manifest.appContext,
          createdAt: manifest.createdAt,
          lastUsed: manifest.lastUsed,
          useCount: manifest.useCount,
        };
      }).filter(Boolean);
    }

    res.json({ macros, total: macros.length });
  });

  // -----------------------------------------------------------
  // GET MACRO DETAILS
  // -----------------------------------------------------------
  app.get('/macro/:id', (req, res) => {
    const manifest = loadManifest(req.params.id);
    if (!manifest) return res.status(404).json({ error: 'Macro not found' });
    res.json(manifest);
  });

  // -----------------------------------------------------------
  // DELETE MACRO
  // -----------------------------------------------------------
  app.delete('/macro/:id', (req, res) => {
    const macroDir = path.join(MACROS_DIR, req.params.id);
    if (!fs.existsSync(macroDir)) return res.status(404).json({ error: 'Macro not found' });

    try {
      fs.rmSync(macroDir, { recursive: true, force: true });
      console.log(`[Macro] Deleted: ${req.params.id}`);
      res.json({ success: true, deleted: req.params.id });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // -----------------------------------------------------------
  // UPDATE MACRO (rename, update description/tags)
  // -----------------------------------------------------------
  app.patch('/macro/:id', (req, res) => {
    const manifest = loadManifest(req.params.id);
    if (!manifest) return res.status(404).json({ error: 'Macro not found' });

    const { name, description, tags } = req.body;
    if (name) manifest.name = name;
    if (description) manifest.description = description;
    if (tags) manifest.tags = tags;

    saveManifest(req.params.id, manifest);
    res.json({ success: true, updated: { name: manifest.name, description: manifest.description, tags: manifest.tags } });
  });

  // -----------------------------------------------------------
  // REPLAY MACRO (blocking)
  // -----------------------------------------------------------
  app.post('/macro/replay/:id', async (req, res) => {
    const { speedMultiplier } = req.body;

    try {
      emitMacroEvent({
        type: 'replay_started',
        macroId: req.params.id,
        macroName: loadManifest(req.params.id)?.name || req.params.id,
        totalSteps: loadManifest(req.params.id)?.stepCount || 0,
      });

      const result = await replayMacro(req.params.id, { speedMultiplier });

      emitMacroEvent({ type: 'replay_complete', macroId: req.params.id, ...result });
      res.json(result);
    } catch (err) {
      emitMacroEvent({ type: 'replay_error', macroId: req.params.id, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------
  // REPLAY MACRO (SSE streaming)
  // -----------------------------------------------------------
  app.post('/macro/replay/:id/stream', async (req, res) => {
    const manifest = loadManifest(req.params.id);
    if (!manifest) return res.status(404).json({ error: 'Macro not found' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendEvent = (data) => {
      try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (e) {}
    };

    sendEvent({
      type: 'replay_started',
      macroName: manifest.name,
      totalSteps: manifest.stepCount,
    });

    emitMacroEvent({
      type: 'replay_started',
      macroId: req.params.id,
      macroName: manifest.name,
      totalSteps: manifest.stepCount,
    });

    try {
      const result = await replayMacro(req.params.id, {
        speedMultiplier: req.body?.speedMultiplier,
        onStep: (progress) => {
          sendEvent({ type: 'replay_progress', ...progress });
        },
      });

      sendEvent({ type: 'replay_complete', ...result });
      emitMacroEvent({ type: 'replay_complete', macroId: req.params.id, ...result });
    } catch (err) {
      sendEvent({ type: 'replay_error', error: err.message });
      emitMacroEvent({ type: 'replay_error', macroId: req.params.id, error: err.message });
    }

    res.end();
  });

  // -----------------------------------------------------------
  // SEARCH MACROS (for voice integration)
  // -----------------------------------------------------------
  app.get('/macro/search/:query', (req, res, next) => {
    if (req.params.query === 'enhanced') return next();
    const results = searchMacros(req.params.query);
    res.json({
      query: req.params.query,
      results: results.map(m => ({
        id: m.id,
        name: m.name,
        description: m.description,
        score: m._score,
        stepCount: m.stepCount,
      })),
    });
  });



  // -----------------------------------------------------------
  // PHASE 3+4 ENDPOINTS
  // -----------------------------------------------------------

  // Enhanced search (FTS5 + context ranking)
  app.get('/macro/search/enhanced', (req, res) => {
    const { q, app: currentApp } = req.query;
    if (!q) return res.status(400).json({ error: 'query required (q param)' });
    const results = searchMacrosEnhanced(q, { currentApp }, searchMacros);
    res.json({ query: q, context: { currentApp }, results });
  });

  // Variable endpoints
  app.get('/macro/:id/variables', (req, res) => {
    const manifest = loadManifest(req.params.id);
    if (!manifest) return res.status(404).json({ error: 'Macro not found' });
    const suggested = suggestVariables(manifest);
    const saved = manifest.variables || {};
    res.json({ macroId: req.params.id, suggested, saved });
  });

  app.post('/macro/:id/parameterize', (req, res) => {
    const manifest = loadManifest(req.params.id);
    if (!manifest) return res.status(404).json({ error: 'Macro not found' });
    const { variables: selectedVars } = req.body; // array of var names, or null for all
    const updated = parameterizeMacro(manifest, selectedVars);
    saveManifest(req.params.id, updated);
    res.json({ success: true, variables: updated.variables, parameterizedSteps: updated.steps.length });
  });

  // Replay with variables
  app.post('/macro/replay/:id/vars', async (req, res) => {
    const manifest = loadManifest(req.params.id);
    if (!manifest) return res.status(404).json({ error: 'Macro not found' });
    const { variables: userVars = {}, speedMultiplier } = req.body;
    try {
      // Prepare steps with variable substitution
      const steps = manifest.variables ? prepareForReplay(manifest, userVars) : manifest.steps;
      // Temporarily swap steps for replay
      const origSteps = manifest.steps;
      manifest.steps = steps;
      const result = await replayMacro(req.params.id, { speedMultiplier });
      manifest.steps = origSteps; // restore
      res.json(result);
    } catch(err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Tier 3 stats
  app.get('/macro/tier3/stats', (req, res) => {
    res.json(getTier3Stats());
  });

  // Recent executions
  app.get('/macro/recent', (req, res) => {
    const n = parseInt(req.query.n) || 5;
    res.json({ recent: getRecentMacros(n) });
  });

  // FTS5 index management
  app.post('/macro/index/rebuild', (req, res) => {
    const success = rebuildIndex();
    res.json({ success, message: success ? 'Index rebuilt' : 'Rebuild failed (sqlite3 not available?)' });
  });

  // LLM rename
  app.post('/macro/:id/rename-llm', async (req, res) => {
    const manifest = loadManifest(req.params.id);
    if (!manifest) return res.status(404).json({ error: 'Macro not found' });
    try {
      const name = await generateMacroNameLLM(manifest.steps);
      manifest.llmName = name;
      saveManifest(req.params.id, manifest);
      res.json({ success: true, name });
    } catch(err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Phase 2: Enrich existing macro with semantic data
  app.post('/macro/:id/enrich', async (req, res) => {
    const manifest = loadManifest(req.params.id);
    if (!manifest) return res.status(404).json({ error: 'Macro not found' });

    try {
      console.log(`[Macro] Enriching macro "${manifest.name}" with semantic data...`);
      const enriched = await semanticConverter.enrichExistingMacro(manifest);
      saveManifest(req.params.id, enriched);

      res.json({
        success: true,
        enriched: enriched.enriched,
        successCount: enriched.enrichmentSuccess,
        totalSteps: enriched.enrichmentTotal,
        enrichmentRate: (enriched.enrichmentSuccess / enriched.enrichmentTotal * 100).toFixed(1) + '%',
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Init FTS5 index on startup
  initSearchIndex();
  rebuildIndex();

  console.log('[MacroRecorder] Routes mounted at /macro/* (Phase 2 semantic recording active)');
}

// ---------------------------------------------------------------------------
// Voice Integration Helpers (exported for voice-assistant.js)
// ---------------------------------------------------------------------------

/**
 * Start a recording session. Called when user says "watch me" / "record".
 */
function startRecording() {
  if (isRecording) return { success: false, error: 'Already recording' };

  const id = generateId();
  const macroDir = path.join(MACROS_DIR, id);
  const screenshotsDir = path.join(macroDir, 'screenshots');
  fs.mkdirSync(screenshotsDir, { recursive: true });

  currentRecording = {
    id,
    startTime: Date.now(),
    steps: [],
    screenshotsDir,
    macroDir,
  };
  isRecording = true;

  console.log(`[Macro] Recording started via voice: ${id}`);
  emitMacroEvent({ type: 'recording_started', macroId: id });

  return { success: true, macroId: id };
}

/**
 * Stop recording. Called when user says "stop recording" / "done".
 */
function stopRecording(customName) {
  if (!isRecording || !currentRecording) {
    return { success: false, error: 'Not recording' };
  }

  const recording = currentRecording;
  const duration = (Date.now() - recording.startTime) / 1000;
  const name = customName || autoGenerateName(recording.steps);

  // Build and save manifest
  const appCounts = {};
  recording.steps.forEach(s => {
    const app = s.axContext?.appName || s.axContext?.app || '';
    if (app) appCounts[app] = (appCounts[app] || 0) + 1;
  });
  const primaryApp = Object.entries(appCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';

  const manifest = {
    version: '1.0',
    id: recording.id,
    name,
    description: `${recording.steps.length} steps in ${primaryApp || 'Desktop'}`,
    tags: [],
    createdAt: new Date(recording.startTime).toISOString(),
    duration: Math.round(duration * 10) / 10,
    appContext: primaryApp,
    stepCount: recording.steps.length,
    useCount: 0,
    lastUsed: null,
    steps: recording.steps,
  };

  // Phase 4: Extract variables
  const suggestedVarsV = suggestVariables(manifest);
  if (Object.keys(suggestedVarsV).length > 0) {
    manifest.suggestedVariables = suggestedVarsV;
  }

  saveManifest(recording.id, manifest);

  // LLM naming (async, non-blocking)
  generateMacroNameLLM(recording.steps).then(llmName => {
    if (llmName && llmName !== manifest.name) {
      manifest.llmName = llmName;
      saveManifest(recording.id, manifest);
    }
  }).catch(() => {});

  isRecording = false;
  currentRecording = null;

  console.log(`[Macro] Recording stopped via voice: "${name}" (${manifest.stepCount} steps)`);
  emitMacroEvent({
    type: 'recording_stopped',
    macroId: recording.id,
    name,
    stepCount: manifest.stepCount,
    duration: manifest.duration,
    suggestedName: name,
  });

  return { success: true, macroId: recording.id, name, stepCount: manifest.stepCount, duration: manifest.duration };
}

/**
 * Find and replay a macro by fuzzy name query.
 * Returns the best match or null if no good match found.
 */
async function findAndReplayMacro(query) {
  const results = searchMacros(query);
  if (results.length === 0) {
    return { success: false, error: `No macro found matching "${query}"` };
  }

  const best = results[0];
  if (best._score < 0.3) {
    return { success: false, error: `No close match for "${query}". Best: "${best.name}" (${Math.round(best._score * 100)}% match)` };
  }

  console.log(`[Macro] Voice replay: "${query}" matched "${best.name}" (${Math.round(best._score * 100)}%)`);

  emitMacroEvent({
    type: 'replay_started',
    macroId: best.id,
    macroName: best.name,
    totalSteps: best.stepCount,
  });

  try {
    const result = await replayMacro(best.id);
    emitMacroEvent({ type: 'replay_complete', macroId: best.id, ...result });
    return { success: true, macroName: best.name, ...result };
  } catch (err) {
    emitMacroEvent({ type: 'replay_error', macroId: best.id, error: err.message });
    return { success: false, macroName: best.name, error: err.message };
  }
}

/**
 * Check if recording is active.
 */
function isCurrentlyRecording() {
  return isRecording;
}

/**
 * BUG-03 FIX: Record a computer-use action as a macro step.
 * Called by computer-use.js via the macro recorder hook.
 * This bridges the gap between computer-use actions and macro recording.
 */
function recordComputerAction(action, params, result) {
  if (!isRecording || !currentRecording) return;
  if (action === 'screenshot' || action === 'wait') return; // Don't record non-interaction actions

  const step = {
    id: currentRecording.steps.length,
    type: action,
    timestamp: (Date.now() - currentRecording.startTime) / 1000,
    source: 'computer-use', // Mark as coming from API, not CGEvent tap
  };

  // Map action params to step fields
  if (params.coordinate) {
    step.position = { x: params.coordinate[0], y: params.coordinate[1] };
  }
  if (params.start_coordinate) {
    step.fromPosition = { x: params.start_coordinate[0], y: params.start_coordinate[1] };
  }
  if (params.text) step.text = params.text;
  if (params.scroll_direction) step.direction = params.scroll_direction;
  if (params.scroll_amount) step.amount = params.scroll_amount;

  currentRecording.steps.push(step);

  const stepCount = currentRecording.steps.length;
  emitMacroEvent({
    type: 'recording_step',
    stepCount,
    lastAction: `${action}${params.coordinate ? ` at (${params.coordinate[0]},${params.coordinate[1]})` : ''}`,
  });

  console.log(`[Macro] Computer-use action recorded: ${action} (step ${stepCount})`);
}

// ---------------------------------------------------------------------------
// Module Exports
// ---------------------------------------------------------------------------
module.exports = {
  mountMacroRecorderRoutes,
  handleMacroStream,
  emitMacroEvent,
  setOverlayEmitter,
  // Voice integration
  startRecording,
  stopRecording,
  findAndReplayMacro,
  isCurrentlyRecording,
  searchMacros,
  // BUG-03 FIX: Bridge for computer-use actions
  recordComputerAction,
  // Phase 2: Semantic action support
  captureSemanticAction,
  resolveSemanticAction,
  // Phase 3+4
  loadManifest,
  replayMacro,
};

