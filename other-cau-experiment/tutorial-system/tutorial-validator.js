'use strict';

/**
 * tutorial-validator.js
 * Validates whether the user clicked the right thing after a tutorial step.
 * 3-tier validation cascade: proximity → AX state → fallback.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'it', 'in', 'on', 'at', 'to', 'of', 'and', 'or',
  'for', 'with', 'this', 'that', 'be', 'was', 'are', 'has', 'have', 'do',
  'not', 'no', 'by', 'as', 'if', 'from', 'into', 'which', 'its', 'their',
]);

/**
 * Calculate Euclidean distance from click to center of step target rect.
 * @param {number} clickX
 * @param {number} clickY
 * @param {object} step - TutorialStep with targetX, targetY, targetW, targetH
 * @returns {{ proximate: boolean, distance: number }}
 */
function isClickProximate(clickX, clickY, step) {
  const centerX = step.targetX + (step.targetW || 0) / 2;
  const centerY = step.targetY + (step.targetH || 0) / 2;
  const dx = clickX - centerX;
  const dy = clickY - centerY;
  const distance = Math.sqrt(dx * dx + dy * dy);
  return {
    proximate: distance <= 40,
    distance,
  };
}

/**
 * Extract non-stopword keywords from a string.
 * @param {string} text
 * @returns {string[]}
 */
function extractKeywords(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ''))
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/**
 * Check AX clickable elements against the expected state.
 * @param {string} expectedState
 * @param {Array<object>} clickableElements
 * @returns {{ matched: boolean, matchedElement: object|null, score: number }}
 */
function assertAXState(expectedState, clickableElements) {
  const keywords = extractKeywords(expectedState);

  if (!keywords.length || !Array.isArray(clickableElements) || !clickableElements.length) {
    return { matched: false, matchedElement: null, score: 0 };
  }

  let bestScore = 0;
  let bestElement = null;

  for (const el of clickableElements) {
    const haystack = [
      el.title || '',
      el.role || '',
      el.description || '',
      el.label || '',
      el.value || '',
    ]
      .join(' ')
      .toLowerCase();

    let hits = 0;
    for (const kw of keywords) {
      if (haystack.includes(kw)) hits++;
    }

    if (hits > bestScore) {
      bestScore = hits;
      bestElement = el;
    }
  }

  const ratio = keywords.length > 0 ? bestScore / keywords.length : 0;
  const matched = bestScore >= 2 || ratio >= 0.5;

  return {
    matched,
    matchedElement: matched ? bestElement : null,
    score: ratio,
  };
}

/**
 * Build an EngineResult envelope.
 * @param {boolean} ok
 * @param {object|null} data
 * @param {string|null} error
 * @param {number} startTime - Date.now() timestamp
 * @returns {object}
 */
function makeResult(ok, data, error, startTime) {
  return {
    ok,
    data: data || null,
    error: error || null,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Build a ValidationResult object.
 * @param {string} verdict - 'correct' | 'incorrect' | 'partial'
 * @param {string} observedState
 * @param {string} expectedState
 * @param {string} method
 * @param {number} confidenceScore
 * @param {string} reason
 * @returns {object}
 */
function makeValidation(verdict, observedState, expectedState, method, confidenceScore, reason) {
  return { verdict, observedState, expectedState, method, confidenceScore, reason };
}

/**
 * Validate whether the user clicked the right thing after a tutorial step.
 * 3-tier cascade: proximity → AX state → fallback proximity-only.
 *
 * @param {object} opts
 * @param {object} opts.step        - TutorialStep
 * @param {number} opts.stepIndex   - current step index
 * @param {number} opts.clickX      - pixel X of user click
 * @param {number} opts.clickY      - pixel Y of user click
 * @param {object} opts.session     - TutorialSession
 * @param {object} [opts.axGrounding] - optional { fetchClickable, resolveActionTarget }
 * @returns {Promise<{ok:boolean, data:object|null, error:string|null, durationMs:number}>}
 */
async function validateStep(opts) {
  const startTime = Date.now();

  const { step, stepIndex, clickX, clickY, axGrounding } = opts;

  if (!step) {
    return makeResult(false, null, 'validateStep: step is required', startTime);
  }

  const expectedState = step.expectedState || '';
  const observedStateLabel = `click@(${clickX},${clickY})`;

  // ── Tier 1: Proximity check ──────────────────────────────────────────────
  const hasTarget =
    step.targetX != null &&
    step.targetY != null;

  let proximityResult = null;
  if (hasTarget) {
    proximityResult = isClickProximate(clickX, clickY, step);

    if (proximityResult.distance > 80) {
      // Clearly outside generous threshold — fail fast
      const validation = makeValidation(
        'incorrect',
        observedStateLabel,
        expectedState,
        'proximity',
        0.9,
        `Click was ${Math.round(proximityResult.distance)}px from target center (threshold: 80px)`,
      );
      return makeResult(true, validation, null, startTime);
    }
    // Between 40–80 px: inconclusive — let AX decide; if no AX, falls to Tier 3
  }

  // ── Tier 2: AX state check ───────────────────────────────────────────────
  if (axGrounding && typeof axGrounding.fetchClickable === 'function') {
    let clickableElements;
    try {
      clickableElements = await axGrounding.fetchClickable();
    } catch (axErr) {
      // AX call failed — degrade to Tier 3
      clickableElements = null;
    }

    if (clickableElements) {
      // Also try targetDesc as a secondary keyword source
      const searchText = expectedState || step.targetDesc || '';
      const axResult = assertAXState(searchText, clickableElements);

      if (axResult.matched) {
        const validation = makeValidation(
          'correct',
          axResult.matchedElement
            ? (axResult.matchedElement.title || axResult.matchedElement.role || 'element')
            : observedStateLabel,
          expectedState,
          'ax',
          0.85,
          `AX element matched with score ${(axResult.score * 100).toFixed(0)}%`,
        );
        return makeResult(true, validation, null, startTime);
      } else {
        const validation = makeValidation(
          'incorrect',
          observedStateLabel,
          expectedState,
          'ax',
          0.7,
          `No AX element matched expected state (best score: ${(axResult.score * 100).toFixed(0)}%)`,
        );
        return makeResult(true, validation, null, startTime);
      }
    }
  }

  // ── Tier 3: Fallback proximity-only ─────────────────────────────────────
  if (!hasTarget) {
    // No target coords and no AX — cannot validate meaningfully
    const validation = makeValidation(
      'partial',
      observedStateLabel,
      expectedState,
      'proximity_only',
      0.5,
      'No target coordinates and no AX grounding available; cannot validate click',
    );
    return makeResult(true, validation, null, startTime);
  }

  const proximate = proximityResult ? proximityResult.proximate : false;
  const distance = proximityResult ? Math.round(proximityResult.distance) : -1;

  if (proximate) {
    const validation = makeValidation(
      'correct',
      observedStateLabel,
      expectedState,
      'proximity_only',
      0.5,
      `Click within 40px of target center (${distance}px); AX unavailable`,
    );
    return makeResult(true, validation, null, startTime);
  } else {
    const validation = makeValidation(
      'incorrect',
      observedStateLabel,
      expectedState,
      'proximity_only',
      0.5,
      `Click ${distance}px from target center; exceeds 40px threshold; AX unavailable`,
    );
    return makeResult(true, validation, null, startTime);
  }
}

module.exports = { validateStep };
