'use strict';

/**
 * tutorial-bus.js
 * Shared EventEmitter singleton for cross-module communication.
 * All Atlas Tutorial modules emit and listen on this single bus.
 *
 * Events:
 *   'transcription'      { text: String }
 *   'step_ready'         { step: TutorialStep, index: Number }
 *   'plan_complete'      { steps: TutorialStep[] }
 *   'plan_error'         { message: String }
 *   'tts_ready'          { index: Number, wavPath: String }
 *   'tts_error'          { index: Number, message: String }
 *   'ax_result'          { requestId: String, x, y, w, h, found: Boolean }
 *   'state_change'       { from: String, to: String }
 *   'correction_needed'  { step: TutorialStep, attemptN: Number }
 *   'overlay_message'    { ...parsed WS message from overlay }
 */

const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(20);

module.exports = bus;
