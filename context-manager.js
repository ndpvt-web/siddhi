/**
 * context-manager.js - Layered Context Assembly for Computer Use Agent
 *
 * Single responsibility: Assemble the optimal LLM context for each iteration.
 * Replaces scattered context logic in computer-use.js, ax-grounding.js, trajectory.js.
 *
 * Architecture:
 *   Layer 0: PERCEPTION  - Current screenshot (image) + task-relevant AX elements
 *   Layer 1: WORKING     - Last N screenshots as images (visual continuity)
 *   Layer 2: NARRATIVE   - Older screenshots replaced with SCENE text from trajectory
 *   Layer 3: KNOWLEDGE   - Trajectory hints + learning context + environment
 *
 * Inputs:  screenshot, AX tree cache, trajectory graph, learning context, task description
 * Outputs: system prompt (with layered context), messages array (images managed), token stats
 */
'use strict';

// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {
  // How many recent screenshots to keep as full images
  recentImageCount: 2,

  // Max AX elements to inject (after semantic filtering)
  maxAXElements: 15,

  // Max text fields to inject
  maxTextFields: 10,

  // Approximate token budget for context (excluding images)
  // Images are ~10K tokens each; text context should stay lean
  textTokenBudget: 4000,

  // Approximate tokens per character (for budget estimation)
  tokensPerChar: 0.3,

  // Max conversation messages before trimming oldest
  maxMessages: 40,
};

// ============================================================
// LAYER 0: PERCEPTION - Current AX Context (task-relevant)
// ============================================================

/**
 * Build AX context string filtered by task relevance.
 * Instead of dumping first 40 elements, uses semantic search to find
 * elements relevant to the current task description.
 *
 * @param {object} axGrounding - ax-grounding module
 * @param {object} semanticSearch - ax-semantic-search module
 * @param {string} taskDescription - Current task or sub-goal
 * @param {number} timeout - AX fetch timeout in ms
 * @returns {Promise<string>} - Formatted AX context for system prompt
 */
async function buildAXContext(axGrounding, semanticSearch, taskDescription, timeout = 2500) {
  if (!axGrounding.isEnabled()) return '';

  try {
    const [clickable, fields] = await Promise.all([
      axGrounding.fetchClickable(timeout),
      axGrounding.fetchTextFields(Math.round(timeout * 0.7)),
    ]);

    if (!clickable || !clickable.clickable || clickable.clickable.length === 0) {
      return '';
    }

    const allElements = clickable.clickable;
    const appName = clickable.app || 'Unknown';
    const lines = [];

    // Semantic filtering: find elements relevant to the task
    let relevantElements;
    if (taskDescription && semanticSearch && allElements.length > CONFIG.maxAXElements) {
      try {
        // Build lightweight AX tree format for semantic search
        const axTree = allElements.map(el => ({
          role: el.role,
          title: el.title || '',
          description: el.description || '',
          x: el.x, y: el.y,
          width: el.width, height: el.height,
        }));

        const matches = await semanticSearch.semanticSearchAX(taskDescription, axTree);
        if (matches.length > 0) {
          // Use semantic matches + top remaining by position (fallback coverage)
          const matchSet = new Set(matches.map(m => `${m.x},${m.y}`));
          const nonMatches = allElements.filter(el => !matchSet.has(`${el.x},${el.y}`));
          relevantElements = [
            ...matches.slice(0, CONFIG.maxAXElements - 3),
            ...nonMatches.slice(0, 3),  // Always include a few positional elements for context
          ].slice(0, CONFIG.maxAXElements);
        }
      } catch (e) {
        // Semantic search failed, fall back to positional
      }
    }

    // Fallback: first N elements by position
    if (!relevantElements) {
      relevantElements = allElements.slice(0, CONFIG.maxAXElements);
    }

    lines.push(`\n## Accessibility Elements (${appName}) - ${relevantElements.length} of ${allElements.length} elements (task-relevant)`);
    lines.push('Native UI elements with pixel-precise coordinates. For web page content, rely on visual analysis.\n');

    for (const el of relevantElements) {
      const label = el.title || '(unlabeled)';
      lines.push(`- [${el.role}] "${label}" center=(${Math.round(el.x)}, ${Math.round(el.y)}) size=${el.width}x${el.height}`);
    }

    if (allElements.length > relevantElements.length) {
      lines.push(`  ... and ${allElements.length - relevantElements.length} more elements (not shown - use AX snap for precise clicks)`);
    }

    // Text fields
    if (fields && fields.fields && fields.fields.length > 0) {
      lines.push('\nText input fields:');
      for (const f of fields.fields.slice(0, CONFIG.maxTextFields)) {
        const label = f.title || f.role;
        const val = f.value ? ` value="${f.value.slice(0, 60)}"` : '';
        const focus = f.focused ? ' [FOCUSED]' : '';
        lines.push(`- [${label}]${val}${focus}`);
      }
    }

    return lines.join('\n');
  } catch (err) {
    console.log('[ContextMgr] AX context error (non-fatal):', err.message);
    return '';
  }
}

// ============================================================
// LAYER 2: NARRATIVE - Screenshot-to-text conversion
// ============================================================

/**
 * Get the SCENE description for a given trajectory step index.
 * Falls back to checkpoint description or action summary.
 *
 * @param {object} trajectory - TrajectoryGraph instance
 * @param {number} stepIndex - Step index in trajectory
 * @returns {string} - Semantic description of what was on screen
 */
function getSceneForStep(trajectory, stepIndex) {
  if (!trajectory || !trajectory.nodes || stepIndex >= trajectory.nodes.length) {
    return null;
  }

  const node = trajectory.nodes[stepIndex];
  if (!node) return null;

  // Priority 1: SCENE description from LLM (highest quality - explicit state description)
  // Only use if it looks like a real scene description, not just an action echo
  if (node.semanticState && !node.semanticState.startsWith('left_click') && !node.semanticState.startsWith('key ')) {
    return node.semanticState;
  }

  // Priority 2: Checkpoint description (verified-good state, labeled by the agent)
  const checkpoint = trajectory.checkpoints ? trajectory.checkpoints.find(cp => cp.nodeIndex === stepIndex) : null;
  if (checkpoint && checkpoint.description) {
    return '[Checkpoint] ' + checkpoint.description;
  }

  // Priority 3: AX-resolved target (e.g., "Clicked 'Save' button in TextEdit")
  if (node.resolvedTarget) {
    const t = node.resolvedTarget;
    const appSuffix = t.app ? ' in ' + t.app : '';
    const actionType = node.action ? (node.action.type || 'clicked') : 'interacted with';
    let verb = 'Interacted with';
    if (actionType === 'left_click') verb = 'Clicked';
    else if (actionType === 'double_click') verb = 'Double-clicked';
    else if (actionType === 'right_click') verb = 'Right-clicked';
    return verb + " '" + t.label + "' (" + t.role + ")" + appSuffix;
  }

  // Priority 4: Assistant's stated intent (from the message before the action)
  if (node.assistantIntent) {
    return node.assistantIntent;
  }

  // Priority 5: Structured action description (type + text, no raw coordinates)
  if (node.action) {
    const action = node.action.action || node.action.type || 'unknown';
    const text = node.action.text || '';
    if (action === 'screenshot') return 'Screenshot captured';
    if (action === 'key') return 'Pressed key: ' + text;
    if (action === 'type') return 'Typed: "' + text.slice(0, 50) + '"';
    // Last resort: coordinates (better than nothing)
    if ((action === 'left_click' || action === 'click') && node.action.coordinates) {
      return 'Clicked at (' + node.action.coordinates[0] + ', ' + node.action.coordinates[1] + ')';
    }
    return 'Action: ' + action;
  }

  return 'Previous step';
}

// ============================================================
// LAYER 3: KNOWLEDGE - System prompt assembly
// ============================================================

/**
 * Build the full system prompt with layered knowledge context.
 *
 * @param {string} basePrompt - Base system prompt (DEFAULT_SYSTEM_PROMPT)
 * @param {object} trajectory - TrajectoryGraph instance (may be null)
 * @param {string|null} learningContext - Pre-built learning context string
 * @param {string} axContext - AX context string from buildAXContext()
 * @returns {string} - Complete system prompt
 */
function buildSystemPrompt(basePrompt, trajectory, learningContext, axContext) {
  let prompt = basePrompt;

  // Inject trajectory hints (recovery level, checkpoints, similar trajectories)
  try {
    if (trajectory) {
      const hints = trajectory.getAgentHints(learningContext);
      if (hints) {
        prompt += '\n\n' + hints;
      } else if (learningContext) {
        prompt += '\n\n===== LEARNED EXPERIENCE (from past tasks) =====\n' + learningContext;
      }
    } else if (learningContext) {
      prompt += '\n\n===== LEARNED EXPERIENCE (from past tasks) =====\n' + learningContext;
    }
  } catch (e) {
    console.error('[ContextMgr] Trajectory hints error:', e.message);
  }

  // Inject AX context
  if (axContext) {
    prompt += '\n' + axContext;
  }

  return prompt;
}

// ============================================================
// CORE: MESSAGE HISTORY MANAGEMENT
// ============================================================

/**
 * Manage message history: replace old screenshots with SCENE text.
 * This is the core function that replaces the inline code in computer-use.js lines 1883-1918.
 *
 * Walks messages from newest to oldest. Keeps the most recent N screenshots as images.
 * Replaces older screenshots with their trajectory SCENE description.
 *
 * @param {Array} messages - Conversation messages array (mutated in place)
 * @param {object|null} trajectory - TrajectoryGraph instance for SCENE lookups
 * @returns {object} - Stats: { kept, replaced, trimmed, totalMessages }
 */
function manageHistory(messages, trajectory) {
  const stats = { kept: 0, replaced: 0, trimmed: 0, totalMessages: messages.length };

  // Track which screenshot we're on (newest first) and map to trajectory steps
  let screenshotIndex = 0;  // 0 = newest screenshot in messages
  let trajectoryStep = trajectory ? trajectory.nodes.length - 1 : -1;

  // Pass 1: Count total screenshots to map indices to trajectory steps
  let totalScreenshots = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg.content || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'image' && block.source?.data) {
        totalScreenshots++;
      }
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        for (const sub of block.content) {
          if (sub.type === 'image' && sub.source?.data) {
            totalScreenshots++;
          }
        }
      }
    }
  }

  // Pass 2: Replace old screenshots with SCENE text
  let screenshotCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg.content || !Array.isArray(msg.content)) continue;

    for (let j = msg.content.length - 1; j >= 0; j--) {
      const block = msg.content[j];

      // Handle tool_result with nested image
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        for (let k = block.content.length - 1; k >= 0; k--) {
          if (block.content[k].type === 'image' && block.content[k].source?.data) {
            screenshotCount++;
            const stepIdx = totalScreenshots - screenshotCount;

            if (screenshotCount > CONFIG.recentImageCount) {
              // Replace with SCENE description
              const scene = getSceneForStep(trajectory, stepIdx);
              const sceneText = scene
                ? `[Step ${stepIdx}: ${scene}]`
                : `[Step ${stepIdx}: screenshot taken]`;
              block.content[k] = { type: 'text', text: sceneText };
              stats.replaced++;
            } else {
              stats.kept++;
            }
          }
        }
      }

      // Handle direct image in user message
      if (block.type === 'image' && block.source?.data) {
        screenshotCount++;
        const stepIdx = totalScreenshots - screenshotCount;

        if (screenshotCount > CONFIG.recentImageCount) {
          const scene = getSceneForStep(trajectory, stepIdx);
          const sceneText = scene
            ? `[Step ${stepIdx}: ${scene}]`
            : `[Step ${stepIdx}: initial screenshot]`;
          msg.content[j] = { type: 'text', text: sceneText };
          stats.replaced++;
        } else {
          stats.kept++;
        }
      }
    }
  }

  // Pass 3: Trim old messages if conversation is too long
  if (messages.length > CONFIG.maxMessages + 1) {
    const removed = messages.splice(1, messages.length - CONFIG.maxMessages - 1);
    stats.trimmed = removed.length;
    console.log(`[ContextMgr] Trimmed ${removed.length} old messages (keeping last ${CONFIG.maxMessages})`);
  }

  if (stats.replaced > 0) {
    console.log(`[ContextMgr] Screenshots: ${stats.kept} kept as images, ${stats.replaced} replaced with SCENE text`);
  }

  stats.totalMessages = messages.length;
  return stats;
}

// ============================================================
// PUBLIC API: assembleContext()
// ============================================================

/**
 * Main entry point: Assemble optimal context for an agent iteration.
 *
 * Call this ONCE per iteration, before the LLM API call.
 * It handles: AX context building, system prompt assembly, and message history management.
 *
 * @param {object} opts
 * @param {string} opts.baseSystemPrompt - Base system prompt text
 * @param {Array} opts.messages - Conversation messages array (mutated in place)
 * @param {object|null} opts.trajectory - TrajectoryGraph instance
 * @param {string|null} opts.learningContext - Pre-built learning context from learning.js
 * @param {string} opts.taskDescription - Current task description for AX filtering
 * @param {object} opts.axGrounding - ax-grounding module
 * @param {object} opts.semanticSearch - ax-semantic-search module (optional)
 * @param {number} [opts.axTimeout=2500] - Timeout for AX fetch
 * @returns {Promise<object>} - { systemPrompt, historyStats, axElementCount }
 */
async function assembleContext(opts) {
  const {
    baseSystemPrompt,
    messages,
    trajectory,
    learningContext,
    taskDescription,
    axGrounding,
    semanticSearch,
    axTimeout = 2500,
  } = opts;

  // Layer 0: Build task-relevant AX context
  let axContext = '';
  let axElementCount = 0;
  try {
    axContext = await buildAXContext(axGrounding, semanticSearch, taskDescription, axTimeout);
    if (axContext) {
      // Count elements from the formatted string
      axElementCount = (axContext.match(/^- \[/gm) || []).length;
      console.log(`[ContextMgr] AX: ${axElementCount} task-relevant elements injected`);
    }
  } catch (e) {
    console.log('[ContextMgr] AX pre-fetch failed (non-fatal):', e.message);
  }

  // Layer 3 + Layer 0: Assemble system prompt
  const systemPrompt = buildSystemPrompt(baseSystemPrompt, trajectory, learningContext, axContext);

  // Layer 1 + 2: Manage message history (keep recent images, replace old with SCENE)
  const historyStats = manageHistory(messages, trajectory);

  return {
    systemPrompt,
    historyStats,
    axElementCount,
  };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  assembleContext,
  buildAXContext,
  buildSystemPrompt,
  manageHistory,
  getSceneForStep,
  CONFIG,
};
