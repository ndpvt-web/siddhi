'use strict';

/**
 * tutorial-corrections.js
 * Escalating template library for correction messages.
 * Zero LLM calls -- instant response on every misclick.
 */

/**
 * Get a correction message for a misclicked step.
 * Escalates tone across attempts: gentle -> specific -> emphatic -> patient.
 *
 * @param {object} step - TutorialStep
 * @param {number} attemptN - 1-based attempt count
 * @returns {string}
 */
function getCorrection(step, attemptN) {
  if (!step) return 'Try again -- click the highlighted area.';

  const target = step.targetDesc || step.action || 'the highlighted element';
  const action = (step.action || '').toLowerCase().replace(/\*\*/g, '');

  if (attemptN <= 1) {
    return `Almost! Try clicking ${target}.`;
  }
  if (attemptN === 2) {
    return `I'm pointing at ${target} -- give it a click.`;
  }
  if (attemptN === 3) {
    return `Look for ${target}. It's highlighted in blue.`;
  }
  return `Take your time. ${target} is right where the pointer is.`;
}

/**
 * Get a timeout/reprompt message when the user hasn't acted.
 * Escalates across attempts.
 *
 * @param {object} step - TutorialStep
 * @param {number} attemptN - 1-based attempt count
 * @returns {string}
 */
function getReprompt(step, attemptN) {
  if (!step) return 'Please try again.';

  const action = (step.action || '').toLowerCase().replace(/\*\*/g, '');
  const target = step.targetDesc || 'the highlighted element';

  if (attemptN <= 1) {
    return `Go ahead and ${action}`;
  }
  if (attemptN === 2) {
    return `Look for ${target} and ${action}`;
  }
  return `I'm pointing at ${target}. ${step.action || 'Click it.'}`;
}

module.exports = { getCorrection, getReprompt };
