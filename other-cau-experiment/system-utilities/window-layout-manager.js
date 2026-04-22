/**
 * window-layout-manager.js - Window arrangement and layout persistence
 *
 * PURPOSE:
 *   Manage window arrangements and save/restore workspace layouts.
 *   Enables users to define and reuse window configurations for different tasks.
 *
 * ARCHITECTURE:
 *   - Layout Calculation: Compute window geometries for predefined layouts
 *   - Layout Persistence: Save/restore layouts to JSON files
 *   - Screen Detection: Query display dimensions via JXA
 *   - Multi-Monitor: Support for multiple displays (future enhancement)
 *
 * USAGE:
 *   const wlm = require('./window-layout-manager');
 *   // Tile windows in 2x2 grid
 *   await wlm.tileWindows(windowSpecs, 'quarters');
 *   // Save current layout
 *   await wlm.saveLayout('dev-setup');
 *   // Restore saved layout
 *   await wlm.restoreLayout('dev-setup');
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const coordinator = require('./multi-window-coordinator');

// Configuration
const LAYOUTS_DIR = path.join(process.env.HOME || '/tmp', '.atlas-layouts');
const ANIMATION_DELAY = 100; // ms between window moves

// Layout templates
const LAYOUT_TEMPLATES = {
  'split-left': {
    description: 'First window on left half, others stacked right',
    minWindows: 1,
    maxWindows: 5,
  },
  'split-right': {
    description: 'First window on right half, others stacked left',
    minWindows: 1,
    maxWindows: 5,
  },
  'quarters': {
    description: '2x2 grid of four windows',
    minWindows: 4,
    maxWindows: 4,
  },
  'thirds': {
    description: 'Three equal columns',
    minWindows: 3,
    maxWindows: 3,
  },
  'stack': {
    description: 'Windows stacked vertically',
    minWindows: 1,
    maxWindows: 10,
  },
  'side-by-side': {
    description: 'Two windows side by side',
    minWindows: 2,
    maxWindows: 2,
  },
};

// ============================================================================
// WINDOW TILING
// ============================================================================

/**
 * Tile windows according to layout template.
 * Arranges specified windows in predefined layout patterns.
 *
 * @param {Array} windowSpecs - Array of window specs {appName, title?}
 * @param {string} layout - Layout template name
 * @returns {Promise<object>} - TileResult {success, layout, windowsArranged, geometries}
 */
async function tileWindows(windowSpecs, layout) {
  if (!LAYOUT_TEMPLATES[layout]) {
    throw new Error(`Unknown layout template: ${layout}. Available: ${Object.keys(LAYOUT_TEMPLATES).join(', ')}`);
  }

  const template = LAYOUT_TEMPLATES[layout];
  const windowCount = windowSpecs.length;

  if (windowCount < template.minWindows || windowCount > template.maxWindows) {
    throw new Error(`Layout ${layout} requires ${template.minWindows}-${template.maxWindows} windows, got ${windowCount}`);
  }

  console.log(`[LayoutManager] Tiling ${windowCount} windows in ${layout} layout`);

  try {
    // Use coordinator's arrangeWindows function
    const result = await coordinator.arrangeWindows(layout, windowSpecs);

    return {
      success: result.success,
      layout,
      windowsArranged: result.windowsArranged,
      windowsTotal: result.windowsTotal,
      geometries: result.results.filter(r => r.success).map(r => r.geometry),
      errors: result.results.filter(r => !r.success).map(r => ({ window: r.window, error: r.error })),
      duration: result.duration,
    };
  } catch (error) {
    console.error('[LayoutManager] tileWindows error:', error.message);
    return {
      success: false,
      layout,
      error: error.message,
      windowsArranged: 0,
      windowsTotal: windowSpecs.length,
    };
  }
}

/**
 * Arrange two windows side by side.
 * Convenience function for common 50/50 split.
 *
 * @param {object} leftWindow - Left window spec {appName, title?}
 * @param {object} rightWindow - Right window spec {appName, title?}
 * @returns {Promise<object>} - TileResult
 */
async function sideBySide(leftWindow, rightWindow) {
  return tileWindows([leftWindow, rightWindow], 'side-by-side');
}

/**
 * Arrange windows in custom grid.
 * Allows arbitrary NxM grid layouts.
 *
 * @param {Array} windowSpecs - Window specs to arrange
 * @param {number} rows - Number of rows
 * @param {number} cols - Number of columns
 * @returns {Promise<object>} - TileResult
 */
async function gridLayout(windowSpecs, rows, cols) {
  if (windowSpecs.length !== rows * cols) {
    throw new Error(`Grid ${rows}x${cols} requires ${rows * cols} windows, got ${windowSpecs.length}`);
  }

  const screenDims = await coordinator.getScreenDimensions();
  const cellWidth = screenDims.width / cols;
  const cellHeight = screenDims.height / rows;

  const results = [];

  for (let i = 0; i < windowSpecs.length; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;

    const geometry = {
      x: Math.round(col * cellWidth),
      y: Math.round(row * cellHeight),
      width: Math.round(cellWidth),
      height: Math.round(cellHeight),
    };

    try {
      const windowSpec = windowSpecs[i];
      await coordinator.switchToWindow(windowSpec);
      await setWindowGeometry(windowSpec, geometry);
      await sleep(ANIMATION_DELAY);

      results.push({ window: windowSpec, success: true, geometry });
    } catch (error) {
      console.error(`[LayoutManager] Failed to arrange window ${i}:`, error.message);
      results.push({ window: windowSpecs[i], success: false, error: error.message });
    }
  }

  const successCount = results.filter(r => r.success).length;

  console.log(`[LayoutManager] Grid layout ${rows}x${cols}: ${successCount}/${windowSpecs.length} windows arranged`);

  return {
    success: successCount === windowSpecs.length,
    layout: `grid-${rows}x${cols}`,
    windowsArranged: successCount,
    windowsTotal: windowSpecs.length,
    geometries: results.filter(r => r.success).map(r => r.geometry),
    errors: results.filter(r => !r.success).map(r => ({ window: r.window, error: r.error })),
  };
}

/**
 * Helper: Set window geometry using JXA.
 * Extracted from coordinator for reuse.
 *
 * @param {object} windowSpec - Window spec
 * @param {object} geometry - {x, y, width, height}
 */
async function setWindowGeometry(windowSpec, geometry) {
  const { appName, title, windowIndex } = windowSpec;
  const { x, y, width, height } = geometry;

  const jxaScript = `
    const se = Application("System Events");
    const proc = se.applicationProcesses["${appName}"];

    if (!proc.exists()) {
      throw new Error("Application not found");
    }

    let targetWindow = null;
    ${title ? `
    const windows = proc.windows();
    for (let i = 0; i < windows.length; i++) {
      if (windows[i].title && windows[i].title().includes("${title}")) {
        targetWindow = windows[i];
        break;
      }
    }
    ` : windowIndex !== undefined ? `
    const windows = proc.windows();
    if (windows.length > ${windowIndex}) {
      targetWindow = windows[${windowIndex}];
    }
    ` : `
    targetWindow = proc.windows[0];
    `}

    if (!targetWindow) {
      throw new Error("Window not found");
    }

    targetWindow.position = [${x}, ${y}];
    targetWindow.size = [${width}, ${height}];

    return "ok";
  `;

  execSync(`osascript -l JavaScript -e '${jxaScript.replace(/'/g, "'\\''")}'`, {
    encoding: 'utf8',
    timeout: 5000,
  });
}

// ============================================================================
// LAYOUT PERSISTENCE
// ============================================================================

/**
 * Save current window arrangement as named layout.
 * Captures positions and sizes of all windows.
 *
 * @param {string} name - Layout name
 * @returns {Promise<object>} - SaveResult {success, name, windowCount, filePath}
 */
async function saveLayout(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('[LayoutManager] saveLayout requires valid name');
  }

  try {
    // Ensure layouts directory exists
    if (!fs.existsSync(LAYOUTS_DIR)) {
      fs.mkdirSync(LAYOUTS_DIR, { recursive: true });
    }

    // Capture current window state
    const windows = await coordinator.listWindows();

    if (windows.length === 0) {
      throw new Error('No windows to save');
    }

    const layout = {
      name,
      savedAt: new Date().toISOString(),
      screenDimensions: await coordinator.getScreenDimensions(),
      windows: windows.map(w => ({
        appName: w.appName,
        bundleId: w.bundleId,
        windowTitle: w.windowTitle,
        windowIndex: w.windowIndex,
        position: w.position,
        size: w.size,
        isFocused: w.isFocused,
      })),
    };

    // Write to file
    const filePath = path.join(LAYOUTS_DIR, `${name}.json`);
    fs.writeFileSync(filePath, JSON.stringify(layout, null, 2), 'utf8');

    console.log(`[LayoutManager] Saved layout "${name}" with ${windows.length} windows to ${filePath}`);

    return {
      success: true,
      name,
      windowCount: windows.length,
      filePath,
    };
  } catch (error) {
    console.error('[LayoutManager] saveLayout error:', error.message);
    return {
      success: false,
      name,
      error: error.message,
    };
  }
}

/**
 * Load saved layout by name.
 * Returns layout data without applying it.
 *
 * @param {string} name - Layout name
 * @returns {object|null} - Layout data or null if not found
 */
function loadLayout(name) {
  try {
    const filePath = path.join(LAYOUTS_DIR, `${name}.json`);

    if (!fs.existsSync(filePath)) {
      console.warn(`[LayoutManager] Layout "${name}" not found at ${filePath}`);
      return null;
    }

    const data = fs.readFileSync(filePath, 'utf8');
    const layout = JSON.parse(data);

    console.log(`[LayoutManager] Loaded layout "${name}" with ${layout.windows.length} windows`);

    return layout;
  } catch (error) {
    console.error('[LayoutManager] loadLayout error:', error.message);
    return null;
  }
}

/**
 * List all saved layouts.
 *
 * @returns {Array} - Array of {name, windowCount, savedAt}
 */
function listLayouts() {
  try {
    if (!fs.existsSync(LAYOUTS_DIR)) {
      return [];
    }

    const files = fs.readdirSync(LAYOUTS_DIR);
    const layouts = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        const filePath = path.join(LAYOUTS_DIR, file);
        const data = fs.readFileSync(filePath, 'utf8');
        const layout = JSON.parse(data);

        layouts.push({
          name: layout.name,
          windowCount: layout.windows.length,
          savedAt: layout.savedAt,
          filePath,
        });
      } catch (err) {
        console.warn(`[LayoutManager] Failed to read layout ${file}:`, err.message);
      }
    }

    return layouts;
  } catch (error) {
    console.error('[LayoutManager] listLayouts error:', error.message);
    return [];
  }
}

/**
 * Delete saved layout.
 *
 * @param {string} name - Layout name
 * @returns {boolean} - True if deleted successfully
 */
function deleteLayout(name) {
  try {
    const filePath = path.join(LAYOUTS_DIR, `${name}.json`);

    if (!fs.existsSync(filePath)) {
      console.warn(`[LayoutManager] Layout "${name}" not found`);
      return false;
    }

    fs.unlinkSync(filePath);
    console.log(`[LayoutManager] Deleted layout "${name}"`);
    return true;
  } catch (error) {
    console.error('[LayoutManager] deleteLayout error:', error.message);
    return false;
  }
}

/**
 * Restore saved layout.
 * Moves and resizes windows to match saved state.
 *
 * @param {string} name - Layout name
 * @param {object} options - {launchMissing?, scaleToCurrent?}
 * @returns {Promise<object>} - RestoreResult {success, windowsRestored, windowsMissing, errors}
 */
async function restoreLayout(name, options = {}) {
  const { launchMissing = false, scaleToCurrent = true } = options;

  const layout = loadLayout(name);
  if (!layout) {
    return {
      success: false,
      error: `Layout "${name}" not found`,
    };
  }

  console.log(`[LayoutManager] Restoring layout "${name}" with ${layout.windows.length} windows`);

  const startTime = Date.now();
  const results = [];
  const missing = [];

  // Get current screen dimensions
  const currentScreen = await coordinator.getScreenDimensions();
  const savedScreen = layout.screenDimensions;

  // Calculate scaling factors if needed
  const scaleX = scaleToCurrent ? currentScreen.width / savedScreen.width : 1;
  const scaleY = scaleToCurrent ? currentScreen.height / savedScreen.height : 1;

  // Check which apps are running
  const runningApps = new Set();
  const currentWindows = await coordinator.listWindows();
  for (const win of currentWindows) {
    runningApps.add(win.appName);
  }

  // Launch missing apps if requested
  if (launchMissing) {
    for (const savedWindow of layout.windows) {
      if (!runningApps.has(savedWindow.appName)) {
        console.log(`[LayoutManager] Launching ${savedWindow.appName}`);
        await coordinator.launchApp(savedWindow.appName, false);
        await sleep(1500); // Wait for app to start
        runningApps.add(savedWindow.appName);
      }
    }
  }

  // Restore each window
  for (const savedWindow of layout.windows) {
    if (!runningApps.has(savedWindow.appName)) {
      console.warn(`[LayoutManager] Skipping ${savedWindow.appName} (not running)`);
      missing.push(savedWindow);
      continue;
    }

    try {
      const windowSpec = {
        appName: savedWindow.appName,
        title: savedWindow.windowTitle,
        windowIndex: savedWindow.windowIndex,
      };

      // Scale geometry if needed
      const geometry = {
        x: Math.round(savedWindow.position.x * scaleX),
        y: Math.round(savedWindow.position.y * scaleY),
        width: Math.round(savedWindow.size.width * scaleX),
        height: Math.round(savedWindow.size.height * scaleY),
      };

      // Switch to window and set geometry
      await coordinator.switchToWindow(windowSpec);
      await setWindowGeometry(windowSpec, geometry);
      await sleep(ANIMATION_DELAY);

      results.push({
        window: savedWindow,
        success: true,
        geometry,
      });

      console.log(`[LayoutManager] Restored ${savedWindow.appName} to (${geometry.x},${geometry.y}) ${geometry.width}x${geometry.height}`);
    } catch (error) {
      console.error(`[LayoutManager] Failed to restore ${savedWindow.appName}:`, error.message);
      results.push({
        window: savedWindow,
        success: false,
        error: error.message,
      });
    }
  }

  // Restore focus to originally focused window
  const focusedWindow = layout.windows.find(w => w.isFocused);
  if (focusedWindow && runningApps.has(focusedWindow.appName)) {
    try {
      await coordinator.switchToWindow({
        appName: focusedWindow.appName,
        title: focusedWindow.windowTitle,
      });
    } catch (err) {
      console.warn('[LayoutManager] Failed to restore focus:', err.message);
    }
  }

  const duration = Date.now() - startTime;
  const successCount = results.filter(r => r.success).length;

  console.log(`[LayoutManager] Restored ${successCount}/${layout.windows.length} windows in ${duration}ms (${missing.length} missing)`);

  return {
    success: missing.length === 0 && successCount === layout.windows.length,
    name,
    windowsRestored: successCount,
    windowsTotal: layout.windows.length,
    windowsMissing: missing.length,
    missingApps: missing.map(w => w.appName),
    results,
    duration,
  };
}

/**
 * Capture current workspace snapshot.
 * Similar to saveLayout but returns data without persisting.
 *
 * @returns {Promise<object>} - Workspace snapshot
 */
async function captureSnapshot() {
  const windows = await coordinator.listWindows();
  const screenDims = await coordinator.getScreenDimensions();

  return {
    capturedAt: new Date().toISOString(),
    screenDimensions: screenDims,
    windows: windows.map(w => ({
      appName: w.appName,
      bundleId: w.bundleId,
      windowTitle: w.windowTitle,
      windowIndex: w.windowIndex,
      position: w.position,
      size: w.size,
      isFocused: w.isFocused,
      isMinimized: w.isMinimized,
    })),
  };
}

/**
 * Restore workspace from snapshot.
 * Similar to restoreLayout but uses snapshot object instead of file.
 *
 * @param {object} snapshot - Workspace snapshot
 * @param {object} options - {launchMissing?, scaleToCurrent?}
 * @returns {Promise<object>} - RestoreResult
 */
async function restoreSnapshot(snapshot, options = {}) {
  if (!snapshot || !snapshot.windows) {
    throw new Error('[LayoutManager] Invalid snapshot: missing windows array');
  }

  const { launchMissing = false, scaleToCurrent = true } = options;

  console.log(`[LayoutManager] Restoring snapshot with ${snapshot.windows.length} windows`);

  const startTime = Date.now();
  const results = [];
  const missing = [];

  // Get current screen dimensions
  const currentScreen = await coordinator.getScreenDimensions();
  const savedScreen = snapshot.screenDimensions;

  // Calculate scaling factors
  const scaleX = scaleToCurrent ? currentScreen.width / savedScreen.width : 1;
  const scaleY = scaleToCurrent ? currentScreen.height / savedScreen.height : 1;

  // Check which apps are running
  const runningApps = new Set();
  const currentWindows = await coordinator.listWindows();
  for (const win of currentWindows) {
    runningApps.add(win.appName);
  }

  // Launch missing apps if requested
  if (launchMissing) {
    for (const savedWindow of snapshot.windows) {
      if (!runningApps.has(savedWindow.appName)) {
        await coordinator.launchApp(savedWindow.appName, false);
        await sleep(1500);
        runningApps.add(savedWindow.appName);
      }
    }
  }

  // Restore each window
  for (const savedWindow of snapshot.windows) {
    if (!runningApps.has(savedWindow.appName)) {
      missing.push(savedWindow);
      continue;
    }

    try {
      const windowSpec = {
        appName: savedWindow.appName,
        title: savedWindow.windowTitle,
        windowIndex: savedWindow.windowIndex,
      };

      const geometry = {
        x: Math.round(savedWindow.position.x * scaleX),
        y: Math.round(savedWindow.position.y * scaleY),
        width: Math.round(savedWindow.size.width * scaleX),
        height: Math.round(savedWindow.size.height * scaleY),
      };

      await coordinator.switchToWindow(windowSpec);
      await setWindowGeometry(windowSpec, geometry);
      await sleep(ANIMATION_DELAY);

      results.push({ window: savedWindow, success: true, geometry });
    } catch (error) {
      console.error(`[LayoutManager] Failed to restore ${savedWindow.appName}:`, error.message);
      results.push({ window: savedWindow, success: false, error: error.message });
    }
  }

  const duration = Date.now() - startTime;
  const successCount = results.filter(r => r.success).length;

  return {
    success: missing.length === 0 && successCount === snapshot.windows.length,
    windowsRestored: successCount,
    windowsTotal: snapshot.windows.length,
    windowsMissing: missing.length,
    missingApps: missing.map(w => w.appName),
    results,
    duration,
  };
}

// ============================================================================
// SCREEN UTILITIES
// ============================================================================

/**
 * Get screen dimensions (delegates to coordinator).
 *
 * @returns {Promise<object>} - {width, height}
 */
async function getScreenDimensions() {
  return coordinator.getScreenDimensions();
}

/**
 * Get available layout templates.
 *
 * @returns {object} - Layout template definitions
 */
function getLayoutTemplates() {
  return { ...LAYOUT_TEMPLATES };
}

// ============================================================================
// UTILITIES
// ============================================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Window tiling
  tileWindows,
  sideBySide,
  gridLayout,

  // Layout persistence
  saveLayout,
  loadLayout,
  restoreLayout,
  listLayouts,
  deleteLayout,

  // Snapshot operations
  captureSnapshot,
  restoreSnapshot,

  // Screen utilities
  getScreenDimensions,
  getLayoutTemplates,
};
