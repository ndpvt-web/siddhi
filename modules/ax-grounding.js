/**
 * ax-grounding.js - Hybrid AX + ShowUI grounding for ATLAS Computer-Use Agent
 *
 * ARISTOTELIAN ARCHITECTURE (PHASE 0 - AX INVERSION):
 *   P1: AX API provides pixel-perfect element coordinates in ~10ms (fast, exact, free).
 *   P2: ShowUI provides visual grounding for unlabeled elements in ~500ms (slower, approximate, free).
 *   P3: Claude vision coordinates have 5-20px typical error (slow, approximate, costly).
 *   C:  The optimal cascade is: AX FIRST (primary) -> ShowUI fallback (secondary) -> legacy snap (tertiary).
 *
 * ARCHITECTURE CHANGE (Phase 0):
 *   OLD: Vision-first with AX post-correction (60px snap after vision returns coordinates)
 *   NEW: AX-first grounding with semantic search, vision fallback for edge cases
 *
 * TWO INTEGRATION POINTS:
 *   1. PRIMARY GROUNDING: groundElement() queries AX tree first, uses semantic search,
 *      falls back to ShowUI only for Canvas/sparse trees/visual tasks.
 *   2. PRE-ANALYSIS: getContext() injects AX elements into Claude's prompt (unchanged).
 *   3. LEGACY SNAP: snap() function preserved for backward compatibility.
 *
 * USAGE:
 *   const axg = require('./ax-grounding');
 *   // Primary grounding (NEW in Phase 0)
 *   const result = await axg.groundElement('click the Save button', context);
 *   const coords = await axg.resolveElementToCoordinates(result.elements[0]);
 *   // Pre-fetch for injection into prompt (existing)
 *   const context = await axg.getContext();
 *   // Legacy snap for backward compatibility (existing)
 *   const snapped = axg.snap(x, y);
 *   // Clear cache after UI changes
 *   axg.invalidateCache();
 */

// Direct function imports from brain-macos-bridge (no HTTP, bypasses auth)
const macBridge = require('./brain-macos-bridge');
const semanticSearch = require('./ax-semantic-search');
const { queryClaudeGrounding } = require("./claude-grounding");

// Configuration
const AX_ENABLED = process.env.AX_GROUNDING !== '0';
const AX_FIRST_ENABLED = process.env.AX_FIRST_GROUNDING !== '0';
const SNAP_RADIUS = parseInt(process.env.AX_SNAP_RADIUS || '30');  // Reduced from 60->30 (less aggressive)

// Web browsers: AX only sees toolbar chrome, NOT web page content.
// Skip snap for clicks below toolbar area in these apps.
const WEB_BROWSERS = new Set(['Safari', 'Google Chrome', 'Chrome', 'Firefox', 'Arc', 'Brave Browser', 'Microsoft Edge', 'Opera']);
const TOOLBAR_MAX_Y = 100;  // Below this Y = web content, not browser chrome

// Cache
let _clickableCache = null;
let _textFieldCache = null;
let _axTreeCache = null;
let _cacheTimestamp = 0;
const CACHE_TTL = 3000; // 3 seconds

// Stats
const stats = {
  totalSnaps: 0,
  successfulSnaps: 0,
  preFetches: 0,
  preFetchHits: 0,
  avgFetchMs: 0,
  _fetchTimes: [],
  // Phase 0 stats
  axGroundingCalls: 0,
  axGroundingSuccess: 0,
  fallbackInvocations: 0,
  avgGroundingMs: 0,
  _groundingTimes: [],
};

// ============================================================================
// PHASE 0: PRIMARY GROUNDING - AX-FIRST WITH SEMANTIC SEARCH
// ============================================================================

/**
 * PRIMARY GROUNDING: AX-first with ShowUI fallback.
 * This replaces vision-first approach with semantic-first reasoning.
 *
 * @param {string} taskDescription - Natural language task ("click Build button")
 * @param {object} context - Task context with history, application info
 * @returns {Promise<object>} - AXQueryResult {elements, queryTime, fallbackUsed}
 */
async function groundElement(taskDescription, context = {}) {
  if (!AX_FIRST_ENABLED) {
    throw new Error('[AX-GROUNDING] AX_FIRST_GROUNDING disabled, cannot ground element');
  }

  const startTime = Date.now();
  stats.axGroundingCalls++;

  try {
    // Step 1: Query AX tree
    const axTree = await queryAXTree();

    // Step 2: Check if fallback needed
    if (needsVisualFallback(axTree, taskDescription, context)) {
      console.log('[AX-GROUNDING] Fallback condition detected, using ShowUI');
      return await groundWithShowUIFallback(taskDescription, context, startTime);
    }

    // Step 3: Semantic search in AX tree
    const candidates = await semanticSearch.semanticSearchAX(taskDescription, axTree);

    if (candidates.length === 0) {
      console.log('[AX-GROUNDING] No AX elements match task, falling back to ShowUI');
      return await groundWithShowUIFallback(taskDescription, context, startTime);
    }

    // Step 4: Rank by relevance
    const ranked = await semanticSearch.rankElementsByRelevance(candidates, taskDescription);

    const queryTime = Date.now() - startTime;
    stats.axGroundingSuccess++;
    stats._groundingTimes.push(queryTime);
    if (stats._groundingTimes.length > 20) stats._groundingTimes.shift();
    stats.avgGroundingMs = Math.round(
      stats._groundingTimes.reduce((a, b) => a + b, 0) / stats._groundingTimes.length
    );

    console.log(`[AX-GROUNDING] Found ${ranked.length} matches in ${queryTime}ms (top confidence: ${ranked[0].confidence.toFixed(2)})`);

    return {
      elements: ranked.map(r => r.element),
      queryTime,
      fallbackUsed: false
    };

  } catch (error) {
    console.log(`[AX-GROUNDING] AX query failed: ${error.message}, falling back to ShowUI`);
    return await groundWithShowUIFallback(taskDescription, context, startTime);
  }
}

/**
 * Query full AX tree for the frontmost application.
 * Transforms capy-ax output to AXElement[] format with path generation.
 *
 * @returns {Promise<Array>} - AXElement[] array
 */
async function queryAXTree() {
  if (!AX_ENABLED) {
    return [];
  }

  // Check cache
  const now = Date.now();
  if (_axTreeCache && (now - _cacheTimestamp) < CACHE_TTL) {
    return _axTreeCache;
  }

  const start = Date.now();
  try {
    // Use existing macBridge to get clickable elements
    const result = macBridge.getClickableElements();

    if (result.success) {
      const parsed = JSON.parse(result.output);

      // Transform to AXElement format with path generation
      const axElements = transformToAXElements(parsed);

      _axTreeCache = axElements;
      _cacheTimestamp = Date.now();

      const elapsed = Date.now() - start;
      console.log(`[AX-GROUNDING] Queried AX tree: ${axElements.length} elements in ${elapsed}ms`);

      return axElements;
    } else {
      console.log(`[AX-GROUNDING] queryAXTree failed: ${result.error}`);
      return [];
    }
  } catch (err) {
    console.log(`[AX-GROUNDING] queryAXTree error: ${err.message}`);
    return [];
  }
}

/**
 * Transform capy-ax output to AXElement[] format.
 * Generates XPath-style paths for each element.
 *
 * @param {object} capyOutput - Output from macBridge.getClickableElements()
 * @returns {Array} - AXElement[] array
 */
function transformToAXElements(capyOutput) {
  const elements = [];

  if (!capyOutput.clickable) {
    return elements;
  }

  // Transform each clickable element
  for (const el of capyOutput.clickable) {
    const axElement = {
      role: el.role || 'AXUnknown',
      label: el.title || null,
      value: el.value || null,
      rect: {
        x: el.x || 0,
        y: el.y || 0,
        w: el.width || 0,
        h: el.height || 0
      },
      actions: el.actions || ['AXPress'],
      children: [],
      path: generatePath(el, capyOutput.app)
    };

    elements.push(axElement);
  }

  return elements;
}

/**
 * Generate XPath-style path for an element.
 * Format: /AXWindow/AXToolbar/AXButton[Save]
 *
 * @param {object} element - Raw element from capy-ax
 * @param {string} appName - Application name
 * @returns {string} - XPath-style path
 */
function generatePath(element, appName) {
  const parts = ['AXApplication'];

  // Add window context if available
  parts.push('AXWindow');

  // Add parent context hints based on element properties
  // This is a simplified path generation - real hierarchy would come from full tree walk
  if (element.parent || element.hierarchy) {
    // If we have parent info from capy-ax, use it
    const parentInfo = element.parent || element.hierarchy;
    if (typeof parentInfo === 'string') {
      parts.push(parentInfo);
    }
  }

  // Add the element itself with disambiguating label
  const role = element.role || 'AXUnknown';
  const label = element.title || '';
  const elementPart = label ? `${role}[${label}]` : role;
  parts.push(elementPart);

  return '/' + parts.join('/');
}

/**
 * Search AX tree by semantic criteria.
 * Supports role, label, identifier, and fuzzy matching.
 *
 * @param {object} criteria - Search criteria {role?, label?, identifier?, fuzzyLabel?}
 * @returns {Promise<Array>} - Matching AXElement[]
 */
async function searchAXElements(criteria) {
  const axTree = await queryAXTree();

  if (!axTree || axTree.length === 0) {
    return [];
  }

  let matches = axTree;

  // Filter by role
  if (criteria.role) {
    matches = matches.filter(el => el.role === criteria.role);
  }

  // Filter by exact label
  if (criteria.label) {
    matches = matches.filter(el =>
      el.label && el.label.toLowerCase() === criteria.label.toLowerCase()
    );
  }

  // Filter by identifier
  if (criteria.identifier) {
    matches = matches.filter(el => el.identifier === criteria.identifier);
  }

  // Fuzzy label search
  if (criteria.fuzzyLabel && matches.length === 0) {
    matches = axTree.filter(el => {
      if (!el.label) return false;
      const similarity = semanticSearch.levenshteinDistance(
        el.label.toLowerCase(),
        criteria.fuzzyLabel.toLowerCase()
      );
      const maxLen = Math.max(el.label.length, criteria.fuzzyLabel.length);
      return (1 - similarity / maxLen) > 0.7;
    });
  }

  return matches;
}

/**
 * Resolve AX element to exact click coordinates.
 * Returns center point of element's bounding rectangle.
 * No snap radius needed - AX provides exact bounds.
 *
 * @param {object} element - AXElement to resolve
 * @returns {Promise<object>} - {x, y, confidence, method, element}
 */
async function resolveElementToCoordinates(element) {
  if (!element || !element.rect) {
    throw new Error('[AX-GROUNDING] Cannot resolve: element or rect missing');
  }

  // Center of bounding rectangle
  return {
    x: Math.round(element.rect.x + element.rect.w / 2),
    y: Math.round(element.rect.y + element.rect.h / 2),
    confidence: 1.0,
    method: 'ax-semantic',
    element: element
  };
}

/**
 * Determines whether visual fallback is needed instead of AX.
 * Based on analysis in s4-ax-inversion.md lines 1005-1030.
 *
 * @param {Array} axTree - Queried AX tree
 * @param {string} taskDescription - Task description
 * @param {object} context - Task context
 * @returns {boolean} - True if ShowUI fallback should be used
 */
function needsVisualFallback(axTree, taskDescription, context) {
  // Condition 1: Sparse AX tree (< 10 elements suggests custom UI)
  if (axTree.length < 10) {
    return true;
  }

  // Condition 2: Target is Canvas or custom-drawn region
  const hasCanvas = axTree.some(el =>
    el.role === 'AXCanvas' ||
    el.role === 'AXWebArea' && el.children.length === 0
  );
  if (hasCanvas) {
    return true;
  }

  // Condition 3: Task requires visual reasoning
  const visualKeywords = /\b(color|red|blue|green|icon|image|picture|screenshot|pixel|drawing|graphic)\b/i;
  if (visualKeywords.test(taskDescription)) {
    // Check if AX labels contain the visual property
    const visualProp = extractVisualProperty(taskDescription);
    const axHasVisualProp = axTree.some(el =>
      el.label && el.label.toLowerCase().includes(visualProp)
    );
    if (!axHasVisualProp) {
      return true;
    }
  }

  // Condition 4: Previous AX attempt failed for this task
  if (context.lastAttempt?.method === 'ax' && !context.lastAttempt?.success) {
    return true;
  }

  // Condition 5: Known poor-AX application
  const poorAXApps = [
    'com.adobe.Photoshop',
    'com.unity3d.UnityEditor',
    'com.epicgames.UnrealEditor'
  ];
  if (context.bundleId && poorAXApps.includes(context.bundleId)) {
    return true;
  }

  return false;
}

/**
 * Extract visual property from task description.
 * Used for checking if AX labels contain visual information.
 *
 * @param {string} taskDescription - Task description
 * @returns {string} - Extracted visual property (e.g., "red", "icon")
 */
function extractVisualProperty(taskDescription) {
  const colorMatch = taskDescription.match(/\b(red|blue|green|yellow|orange|purple|pink|black|white|gray)\b/i);
  if (colorMatch) return colorMatch[1].toLowerCase();

  const iconMatch = taskDescription.match(/\b(icon|image|picture|graphic)\b/i);
  if (iconMatch) return iconMatch[1].toLowerCase();

  return '';
}

/**
 * Fallback to ShowUI vision-based grounding.
 * Returns AXQueryResult with fallbackUsed=true.
 *
 * @param {string} taskDescription - Task description
 * @param {object} context - Task context
 * @param {number} startTime - Query start time
 * @returns {Promise<object>} - AXQueryResult with fallbackUsed=true
 */
async function groundWithShowUIFallback(taskDescription, context, startTime) {
  stats.fallbackInvocations++;

  try {
    // Note: This is a placeholder for the actual ShowUI vision integration
    // The real implementation would call the vision-fallback.js module
    // For now, return nearest elements from AX tree as fallback
    console.log('[AX-GROUNDING] ShowUI fallback invoked (placeholder implementation)');

    // Get AX elements as backup metadata
    const axTree = _axTreeCache || await queryAXTree();

    // In real implementation, this would:
    // 1. Take screenshot
    // 2. Call ShowUI-2B model
    // 3. Get vision coordinates
    // 4. Find nearest AX elements for metadata

    return {
      elements: axTree.slice(0, 5),
      queryTime: Date.now() - startTime,
      fallbackUsed: true,
      fallbackReason: 'ax_search_failed'
    };
  } catch (error) {
    console.log(`[AX-GROUNDING] ShowUI fallback error: ${error.message}`);
    return {
      elements: [],
      queryTime: Date.now() - startTime,
      fallbackUsed: true,
      fallbackReason: 'fallback_error',
      error: error.message
    };
  }
}

/**
 * Query AX elements near given coordinates.
 * Used for vision-to-AX coordinate refinement.
 *
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 * @param {number} radius - Search radius in pixels
 * @returns {Promise<Array>} - AXElement[] within radius
 */
async function queryAXElementsNear(x, y, radius) {
  const axTree = await queryAXTree();

  return axTree.filter(el => {
    if (!el.rect) return false;

    const centerX = el.rect.x + el.rect.w / 2;
    const centerY = el.rect.y + el.rect.h / 2;

    const dx = centerX - x;
    const dy = centerY - y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    return dist <= radius;
  });
}

// ============================================================================
// EXISTING: Fetch AX elements (clickable + text fields)
// ============================================================================

/**
 * Fetch all clickable elements from the frontmost app via AX API.
 * Returns: { app, clickable: [{role, title, x, y, width, height}] } or null
 */
async function fetchClickable(timeout = 3000) {
  if (!AX_ENABLED) return null;

  // Check cache
  const now = Date.now();
  if (_clickableCache && (now - _cacheTimestamp) < CACHE_TTL) {
    return _clickableCache;
  }

  const start = Date.now();
  try {
    const result = macBridge.getClickableElements();
    const elapsed = Date.now() - start;

    if (result.success) {
      const parsed = JSON.parse(result.output);
      if (parsed.clickable && parsed.clickable.length > 0) {
        _clickableCache = parsed;
        _cacheTimestamp = Date.now();

        // Track stats
        stats._fetchTimes.push(elapsed);
        if (stats._fetchTimes.length > 20) stats._fetchTimes.shift();
        stats.avgFetchMs = Math.round(stats._fetchTimes.reduce((a, b) => a + b, 0) / stats._fetchTimes.length);

        console.log(`[AX-ground] Fetched ${parsed.clickable.length} clickable elements from ${parsed.app} in ${elapsed}ms`);
        return parsed;
      }
    } else {
      console.log(`[AX-ground] getClickableElements failed: ${result.error}`);
    }
  } catch (err) {
    console.log(`[AX-ground] fetchClickable error: ${err.message}`);
  }

  return null;
}

/**
 * Fetch text fields from the frontmost app.
 * Returns: { app, fields: [{role, title, value, focused}] } or null
 */
async function fetchTextFields(timeout = 2000) {
  if (!AX_ENABLED) return null;

  try {
    const result = macBridge.getTextFields();
    if (result.success) {
      const parsed = JSON.parse(result.output);
      if (parsed.fields && parsed.fields.length > 0) {
        _textFieldCache = parsed;
        return parsed;
      }
    }
  } catch (err) {
    console.log(`[AX-ground] fetchTextFields error: ${err.message}`);
  }
  return null;
}

// ============================================================================
// PRE-ANALYSIS: Format AX context for Claude's system prompt
// ============================================================================

/**
 * Get formatted AX context for injection into Claude's prompt.
 * Fetches both clickable elements and text fields, returns formatted string.
 * Returns empty string if AX is unavailable or no elements found.
 */
async function getContext(timeout = 3000) {
  if (!AX_ENABLED) return '';

  stats.preFetches++;

  try {
    const [clickable, fields] = await Promise.all([
      fetchClickable(timeout),
      fetchTextFields(Math.round(timeout * 0.7)),
    ]);

    if (!clickable || !clickable.clickable || clickable.clickable.length === 0) {
      return '';
    }

    stats.preFetchHits++;
    const lines = [];

    lines.push(`\n## Accessibility Elements (${clickable.app}) - Browser Toolbar Elements (NOT web page content)`);
    lines.push('These are NATIVE TOOLBAR elements only. For web page elements (links, buttons, forms), rely on your VISUAL analysis of the screenshot. These coordinates help for browser chrome (back, forward, tabs, address bar).\n');

    // Clickable elements (cap at 40 for prompt size)
    const elements = clickable.clickable.slice(0, 40);
    for (const el of elements) {
      const label = el.title || '(unlabeled)';
      lines.push(`- [${el.role}] "${label}" center=(${Math.round(el.x)}, ${Math.round(el.y)}) size=${el.width}x${el.height}`);
    }
    if (clickable.clickable.length > 40) {
      lines.push(`  ... and ${clickable.clickable.length - 40} more elements`);
    }

    // Text fields
    if (fields && fields.fields && fields.fields.length > 0) {
      lines.push('\nText input fields:');
      for (const f of fields.fields.slice(0, 15)) {
        const label = f.title || f.role;
        const val = f.value ? ` value="${f.value.slice(0, 60)}"` : '';
        const focus = f.focused ? ' [FOCUSED]' : '';
        lines.push(`- [${label}]${val}${focus}`);
      }
    }

    return lines.join('\n');
  } catch (err) {
    console.log('[AX-ground] getContext error (non-fatal):', err.message);
    return '';
  }
}

// ============================================================================
// LEGACY: Post-correction snap (preserved for backward compatibility)
// ============================================================================

/**
 * Snap click coordinates to the nearest AX element center.
 * If an AX element center is within SNAP_RADIUS px, use that instead.
 *
 * DEPRECATED: Use groundElement() + resolveElementToCoordinates() instead.
 * This function is preserved for backward compatibility with existing code.
 *
 * @param {number} targetX - Claude's estimated X coordinate
 * @param {number} targetY - Claude's estimated Y coordinate
 * @returns {{ x: number, y: number, snapped: boolean, element?: string, distance?: number }}
 */
function snap(targetX, targetY) {
  stats.totalSnaps++;

  // PATCH: Skip snap for web content clicks (below toolbar in web browsers)
  // AX only sees toolbar buttons. Snapping web content clicks to toolbar = WRONG.
  if (_clickableCache && _clickableCache.app && WEB_BROWSERS.has(_clickableCache.app) && targetY > TOOLBAR_MAX_Y) {
    console.log(`[AX-snap] SKIP: target (${targetX},${targetY}) is web content in ${_clickableCache.app} (below toolbar y=${TOOLBAR_MAX_Y})`);
    return { x: targetX, y: targetY, snapped: false, reason: 'web_content' };
  }

  // Auto-refresh cache if empty (e.g., after invalidation between clicks)
  if (!_clickableCache || !_clickableCache.clickable) {
    try {
      const result = macBridge.getClickableElements();
      if (result.success) {
        const parsed = JSON.parse(result.output);
        if (parsed.clickable && parsed.clickable.length > 0) {
          _clickableCache = parsed;
          _cacheTimestamp = Date.now();
        }
      }
    } catch (e) { /* non-fatal */ }
  }

  if (!_clickableCache || !_clickableCache.clickable) {
    return { x: targetX, y: targetY, snapped: false, reason: 'no_cache' };
  }

  let bestDist = Infinity;
  let bestElement = null;

  for (const el of _clickableCache.clickable) {
    const dx = el.x - targetX;
    const dy = el.y - targetY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < bestDist) {
      bestDist = dist;
      bestElement = el;
    }
  }

  if (bestElement && bestDist <= SNAP_RADIUS) {
    stats.successfulSnaps++;
    const snappedX = Math.round(bestElement.x);
    const snappedY = Math.round(bestElement.y);
    console.log(`[AX-snap] (${targetX},${targetY}) -> (${snappedX},${snappedY}) [${bestElement.role}: "${bestElement.title}"] dist=${Math.round(bestDist)}px`);
    return {
      x: snappedX,
      y: snappedY,
      snapped: true,
      element: `${bestElement.role}: ${bestElement.title}`,
      distance: Math.round(bestDist),
    };
  }

  return {
    x: targetX,
    y: targetY,
    snapped: false,
    nearestDist: Math.round(bestDist),
    nearestElement: bestElement ? `${bestElement.role}: ${bestElement.title}` : null,
  };
}

/**
 * Find an AX element by fuzzy title match.
 * Useful for "click the Submit button" type commands.
 *
 * @param {string} query - Partial title to search for
 * @param {string} [role] - Optional role filter (e.g., 'Button', 'Link')
 * @returns {{ found: boolean, element?: object, x?: number, y?: number }}
 */
function findByTitle(query, role) {
  if (!_clickableCache || !_clickableCache.clickable) {
    return { found: false, reason: 'no_cache' };
  }

  const q = query.toLowerCase();
  const matches = [];

  for (const el of _clickableCache.clickable) {
    const title = (el.title || '').toLowerCase();
    if (!title) continue;
    if (role && el.role.toLowerCase() !== role.toLowerCase()) continue;

    // Exact match
    if (title === q) {
      return {
        found: true,
        element: el,
        x: Math.round(el.x),
        y: Math.round(el.y),
        matchType: 'exact',
      };
    }

    // Substring match
    if (title.includes(q) || q.includes(title)) {
      matches.push({ el, score: title === q ? 100 : title.startsWith(q) ? 80 : 50 });
    }
  }

  if (matches.length > 0) {
    matches.sort((a, b) => b.score - a.score);
    const best = matches[0].el;
    return {
      found: true,
      element: best,
      x: Math.round(best.x),
      y: Math.round(best.y),
      matchType: 'fuzzy',
      alternatives: matches.length - 1,
    };
  }

  return { found: false, reason: 'no_match' };
}

// ============================================================================
// CACHE MANAGEMENT
// ============================================================================

/**
 * Invalidate the AX cache. Call after any action that changes the UI
 * (click, type, key press, scroll, etc.)
 */
function invalidateCache() {
  _clickableCache = null;
  _textFieldCache = null;
  _axTreeCache = null;
  _cacheTimestamp = 0;
}

/**
 * Get current grounding stats.
 */
function getStats() {
  return {
    enabled: AX_ENABLED,
    axFirstEnabled: AX_FIRST_ENABLED,
    snapRadius: SNAP_RADIUS,
    // Legacy snap stats
    totalSnaps: stats.totalSnaps,
    successfulSnaps: stats.successfulSnaps,
    snapRate: stats.totalSnaps > 0 ? Math.round(stats.successfulSnaps / stats.totalSnaps * 100) : 0,
    // Pre-fetch stats
    preFetches: stats.preFetches,
    preFetchHitRate: stats.preFetches > 0 ? Math.round(stats.preFetchHits / stats.preFetches * 100) : 0,
    avgFetchMs: stats.avgFetchMs,
    // Phase 0 stats
    axGroundingCalls: stats.axGroundingCalls,
    axGroundingSuccessRate: stats.axGroundingCalls > 0 ? Math.round(stats.axGroundingSuccess / stats.axGroundingCalls * 100) : 0,
    fallbackRate: stats.axGroundingCalls > 0 ? Math.round(stats.fallbackInvocations / stats.axGroundingCalls * 100) : 0,
    avgGroundingMs: stats.avgGroundingMs,
    // Cache stats
    cacheAge: _clickableCache ? Date.now() - _cacheTimestamp : null,
    cachedElements: _clickableCache?.clickable?.length || 0,
    cachedTreeElements: _axTreeCache?.length || 0,
  };
}

// ============================================================================
// ROUTE SETUP: Add monitoring endpoints when mounted in Express
// ============================================================================

function setupRoutes(app) {
  app.get('/computer/ax-stats', (req, res) => {
    res.json(getStats());
  });

  app.get('/computer/ax-context', async (req, res) => {
    try {
      const context = await getContext(4000);
      res.json({
        success: true,
        context,
        stats: getStats(),
        raw: {
          clickable: _clickableCache,
          textFields: _textFieldCache,
          axTree: _axTreeCache,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Direct AX click endpoint (bypasses Claude, uses AX to find and click)
  app.post('/computer/ax-click', async (req, res) => {
    try {
      const { title, role } = req.body || {};
      if (!title) return res.status(400).json({ error: 'title required' });

      // Refresh cache
      await fetchClickable(3000);

      const match = findByTitle(title, role);
      if (!match.found) {
        return res.json({ clicked: false, error: match.reason });
      }

      // Click directly via cliclick
      const { execSync } = require('child_process');
      execSync(`cliclick c:${Math.round(match.x)},${Math.round(match.y)}`, { timeout: 3000 });
      invalidateCache();

      res.json({
        clicked: true,
        element: match.element,
        coordinates: { x: match.x, y: match.y },
        matchType: match.matchType,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Phase 0: AX-first grounding endpoint
  app.post('/computer/ax-ground', async (req, res) => {
    try {
      const { taskDescription, context } = req.body || {};
      if (!taskDescription) {
        return res.status(400).json({ error: 'taskDescription required' });
      }

      const result = await groundElement(taskDescription, context || {});

      res.json({
        success: true,
        result,
        stats: getStats(),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}


/**
 * Resolve click coordinates to a human-readable element description.
 * Uses the cached AX tree (from the same iteration's snap/fetchClickable).
 * This is a READ-ONLY lookup -- does NOT snap or modify coordinates.
 *
 * @param {number} x - Click X coordinate
 * @param {number} y - Click Y coordinate
 * @param {number} [maxDist=80] - Max distance to consider a match
 * @returns {{ label: string, role: string, app: string|null, distance: number }|null}
 */
function resolveActionTarget(x, y, maxDist = 80) {
  if (!_clickableCache || !_clickableCache.clickable) return null;

  let bestDist = Infinity;
  let bestEl = null;

  for (const el of _clickableCache.clickable) {
    const dx = el.x - x;
    const dy = el.y - y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < bestDist) {
      bestDist = dist;
      bestEl = el;
    }
  }

  if (!bestEl || bestDist > maxDist) return null;

  const label = bestEl.title || bestEl.description || '(unlabeled)';
  return {
    label,
    role: bestEl.role || 'Element',
    app: _clickableCache.app || null,
    distance: Math.round(bestDist),
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Phase 0: New primary grounding functions
  groundElement,
  queryAXTree,
  searchAXElements,
  resolveElementToCoordinates,

  // Existing core functions (backward compatible)
  fetchClickable,
  fetchTextFields,
  getContext,
  snap,
  findByTitle,

  // Action enrichment
  resolveActionTarget,

  // Cache management
  invalidateCache,

  // Stats & routes
  getStats,
  setupRoutes,

  // Configuration
  isEnabled: () => AX_ENABLED,
};
