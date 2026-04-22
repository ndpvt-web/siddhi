'use strict';

/**
 * tutorial-planner.js
 * Pedagogical planning module for the Atlas Tutorial System.
 * Provides planTutorial, generateCorrection, generateReprompt via Brain/LLM HTTP calls.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

// ---------------------------------------------------------------------------
// Internal HTTP helper
// ---------------------------------------------------------------------------

/**
 * Post JSON to a URL using Node's built-in http/https modules.
 * Returns parsed JSON response body.
 */
function postJson(urlStr, payload) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch (e) {
      return reject(new Error(`Invalid URL: ${urlStr}`));
    }

    const body = JSON.stringify(payload);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error(`JSON parse error from ${urlStr}: ${e.message} — body: ${raw.slice(0, 200)}`));
        }
      });
    });

    req.on('error', (e) => reject(new Error(`HTTP request failed to ${urlStr}: ${e.message}`)));
    req.setTimeout(30000, () => {
      req.destroy(new Error(`Request to ${urlStr} timed out after 30s`));
    });

    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Step parser
// ---------------------------------------------------------------------------

/**
 * Parse the TUTORIAL: section from LLM output.
 * Expected format per line:
 *   N. [action] | [targetDesc] | [expectedState] | [why] | [pitfall]
 */
function parseTutorialSteps(llmText) {
  const steps = [];

  // Find the TUTORIAL: block
  const tutorialMatch = llmText.match(/TUTORIAL:\s*\n([\s\S]*?)(?:\n\n[A-Z]+:|$)/);
  const block = tutorialMatch ? tutorialMatch[1] : llmText;

  // Match numbered lines: "1. ..." or "1) ..."
  const lineRe = /^\s*(\d+)[.)]\s+(.+)$/gm;
  let match;

  while ((match = lineRe.exec(block)) !== null) {
    const index = parseInt(match[1], 10) - 1; // 0-based
    const rest = match[2];

    // Split by pipe delimiter
    const parts = rest.split('|').map((s) => s.trim());

    // Require at least action | target | expected
    if (parts.length < 3) continue;

    const step = {
      index,
      action:        parts[0] || '',
      targetDesc:    parts[1] || '',
      expectedState: parts[2] || '',
      why:           parts[3] || '',
      pitfall:       parts[4] || '',
      targetX: null,
      targetY: null,
      targetW: null,
      targetH: null,
    };

    steps.push(step);
  }

  return steps;
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

function buildPlanningSystemPrompt({ transcript, session, learningContext, axContext }) {
  const appName = (session && session.appName) ? session.appName : 'the application';
  const currentStep = (session && session.currentStepIndex != null) ? session.currentStepIndex : 0;
  const totalSteps = (session && session.steps && session.steps.length) ? session.steps.length : 0;

  let systemParts = [
    `You are an expert software tutorial instructor creating step-by-step UI walkthroughs.`,
    `Your job is to break down a user's goal into clear, actionable tutorial steps for ${appName}.`,
    ``,
    `CONTEXT:`,
    `- User's request: "${transcript}"`,
    `- Application: ${appName}`,
  ];

  if (totalSteps > 0) {
    systemParts.push(`- Session progress: step ${currentStep + 1} of ${totalSteps}`);
  }

  if (learningContext) {
    if (learningContext.reflections && learningContext.reflections.length > 0) {
      systemParts.push(`\nPAST REFLECTIONS (what has helped this user):`);
      learningContext.reflections.slice(-3).forEach((r) => {
        systemParts.push(`  - ${typeof r === 'string' ? r : JSON.stringify(r)}`);
      });
    }
    if (learningContext.strategies && learningContext.strategies.length > 0) {
      systemParts.push(`\nEFFECTIVE TEACHING STRATEGIES for this user:`);
      learningContext.strategies.slice(-3).forEach((s) => {
        systemParts.push(`  - ${typeof s === 'string' ? s : JSON.stringify(s)}`);
      });
    }
    if (learningContext.segments && learningContext.segments.length > 0) {
      systemParts.push(`\nUSER SKILL SEGMENTS:`);
      learningContext.segments.slice(-2).forEach((seg) => {
        systemParts.push(`  - ${typeof seg === 'string' ? seg : JSON.stringify(seg)}`);
      });
    }
  }

  if (axContext) {
    systemParts.push(`\nCURRENT UI STATE (AX tree summary):\n${axContext}`);
  }

  systemParts = systemParts.concat([
    ``,
    `INSTRUCTIONS:`,
    `- Create a numbered list of tutorial steps that accomplishes the user's goal.`,
    `- Each step must be a single atomic UI action (click, type, select, scroll, etc.).`,
    `- Use this EXACT format for each step:`,
    ``,
    `TUTORIAL:`,
    `1. [Action verb phrase] | [UI element description] | [expected result/state] | [why this step matters] | [common pitfall to avoid]`,
    `2. [Action verb phrase] | [UI element description] | [expected result/state] | [why this step matters] | [common pitfall to avoid]`,
    `...`,
    ``,
    `- Keep action verbs imperative (Click, Type, Select, Press, Drag, Scroll).`,
    `- Target descriptions should be specific enough to identify the UI element visually.`,
    `- Expected state should describe what the user will see after the action.`,
    `- Why should be concise (5-15 words).`,
    `- Pitfall should be the most common mistake (5-20 words) or "None" if there isn't one.`,
    `- Aim for 3-8 steps total. Break complex actions into sub-steps.`,
  ]);

  return systemParts.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Plan a tutorial for the given transcript and session context.
 *
 * @param {object} opts
 * @param {string} opts.transcript
 * @param {object} opts.session        - TutorialSession
 * @param {string} [opts.brainUrl]
 * @param {object} [opts.learningContext]
 * @param {string} [opts.axContext]
 * @returns {Promise<{ok: boolean, data: TutorialStep[]|null, error: string|null, durationMs: number}>}
 */
async function planTutorial(opts) {
  const start = Date.now();
  const {
    transcript,
    session,
    brainUrl = 'http://localhost:7888/brain/query',
    learningContext,
    axContext,
  } = opts || {};

  try {
    if (!transcript) {
      return { ok: false, data: null, error: 'transcript is required', durationMs: Date.now() - start };
    }

    const system = buildPlanningSystemPrompt({ transcript, session, learningContext, axContext });
    const prompt = `Please create a tutorial for: "${transcript}"`;

    let data;
    try {
      data = await postJson(brainUrl, { prompt, system, model: 'sonnet' });
    } catch (httpErr) {
      return { ok: false, data: null, error: `Brain HTTP error: ${httpErr.message}`, durationMs: Date.now() - start };
    }

    const llmText = data && data.response;
    if (!llmText) {
      return { ok: false, data: null, error: 'Brain returned empty response', durationMs: Date.now() - start };
    }

    const steps = parseTutorialSteps(llmText);
    if (steps.length === 0) {
      return { ok: false, data: null, error: `Could not parse tutorial steps from LLM response: ${llmText.slice(0, 300)}`, durationMs: Date.now() - start };
    }

    return { ok: true, data: steps, error: null, durationMs: Date.now() - start };
  } catch (err) {
    return { ok: false, data: null, error: `planTutorial unexpected error: ${err.message}`, durationMs: Date.now() - start };
  }
}

/**
 * Generate a correction narration when a step's observed state doesn't match expected.
 *
 * @param {object} opts
 * @param {object} opts.step           - TutorialStep
 * @param {number} opts.stepIndex
 * @param {object} opts.session        - TutorialSession
 * @param {string} [opts.brainUrl]
 * @param {string} [opts.observedState]
 * @returns {Promise<{ok: boolean, data: string|null, error: string|null, durationMs: number}>}
 */
async function generateCorrection(opts) {
  const start = Date.now();
  const {
    step,
    stepIndex,
    session,
    brainUrl = 'http://localhost:7888/brain/query',
    observedState,
  } = opts || {};

  const fallback = step
    ? `That wasn't quite right. Try to ${step.action.toLowerCase()} instead.`
    : "That wasn't quite right. Please try again.";

  try {
    if (!step) {
      return { ok: false, data: fallback, error: 'step is required', durationMs: Date.now() - start };
    }

    const appName = (session && session.appName) ? session.appName : 'the application';

    const system = [
      `You are a helpful, concise tutorial assistant for ${appName}.`,
      `Explain in 1-2 sentences what went wrong and how to correct it.`,
      `Be encouraging and specific. Do not repeat the step number.`,
    ].join('\n');

    const prompt = [
      `The user was supposed to: ${step.action}`,
      `Target element: ${step.targetDesc}`,
      `Expected state after action: ${step.expectedState}`,
      observedState ? `What was actually observed: ${observedState}` : null,
      step.pitfall && step.pitfall !== 'None' ? `Common pitfall for this step: ${step.pitfall}` : null,
      ``,
      `Write a brief, encouraging correction message (1-2 sentences).`,
    ].filter(Boolean).join('\n');

    let data;
    try {
      data = await postJson(brainUrl, { prompt, system, model: 'sonnet' });
    } catch (httpErr) {
      // Graceful fallback on HTTP failure
      return { ok: true, data: fallback, error: null, durationMs: Date.now() - start };
    }

    const llmText = data && data.response && data.response.trim();
    if (!llmText) {
      return { ok: true, data: fallback, error: null, durationMs: Date.now() - start };
    }

    return { ok: true, data: llmText, error: null, durationMs: Date.now() - start };
  } catch (err) {
    return { ok: true, data: fallback, error: `generateCorrection error (using fallback): ${err.message}`, durationMs: Date.now() - start };
  }
}

/**
 * Generate a reprompt string for a step based on attempt number.
 * Pure synchronous — no LLM call.
 *
 * @param {object} step    - TutorialStep
 * @param {number} attempt - 1-based attempt count
 * @returns {string}
 */
function generateReprompt(step, attempt) {
  if (!step) return 'Please try again.';

  if (attempt <= 1) {
    return `Go ahead and ${step.action.toLowerCase()}`;
  } else if (attempt === 2) {
    return `Look for ${step.targetDesc} and ${step.action.toLowerCase()}`;
  } else {
    return `I'm pointing at ${step.targetDesc}. ${step.action}`;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { planTutorial, generateCorrection, generateReprompt };
