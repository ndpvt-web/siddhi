'use strict';

const crypto = require('crypto');
const {
  TutorialState,
  createSession,
  getActiveSession,
  updateSession,
  completeSession,
  cancelSession,
  getHistory,
} = require('./tutorial-session');

// ── Wave 2 modules ──────────────────────────────────────────────────────────

const planner = require('./tutorial-planner');
const validator = require('./tutorial-validator');
const narrator = require('./tutorial-narrator');

// ── State machine legal transitions ──────────────────────────────────────────

const LEGAL_TRANSITIONS = {
  [TutorialState.IDLE]:       [TutorialState.LISTENING, TutorialState.CANCELLED],
  [TutorialState.LISTENING]:  [TutorialState.PLANNING, TutorialState.IDLE, TutorialState.CANCELLED],
  [TutorialState.PLANNING]:   [TutorialState.GUIDING, TutorialState.IDLE, TutorialState.CANCELLED],
  [TutorialState.GUIDING]:    [TutorialState.VALIDATING, TutorialState.CORRECTING, TutorialState.CANCELLED],
  [TutorialState.VALIDATING]: [TutorialState.GUIDING, TutorialState.CORRECTING, TutorialState.COMPLETED, TutorialState.CANCELLED],
  [TutorialState.CORRECTING]: [TutorialState.GUIDING, TutorialState.CANCELLED],
  [TutorialState.COMPLETED]:  [TutorialState.IDLE, TutorialState.CANCELLED],
  [TutorialState.CANCELLED]:  [TutorialState.IDLE],
};

// ── Module state ─────────────────────────────────────────────────────────────

/** @type {Set<import('net').Socket>} */
const overlayClients = new Set();

let _currentState = TutorialState.IDLE;
let _audioBuffer = []; // base64 PCM chunks
let _listeningTimer = null;
let _repromptTimer = null;
let _reguideTimer = null;

// ── WebSocket frame helpers ───────────────────────────────────────────────────

/**
 * Parse a single WebSocket frame from a buffer.
 * Returns { opcode, payload, isFinal, consumed } or null if incomplete.
 */
function parseWSFrame(buffer) {
  if (buffer.length < 2) return null;

  const byte0 = buffer[0];
  const byte1 = buffer[1];
  const isFinal = !!(byte0 & 0x80);
  const opcode  = byte0 & 0x0f;
  const masked  = !!(byte1 & 0x80);
  let payloadLen = byte1 & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buffer.length < offset + 2) return null;
    payloadLen = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLen === 127) {
    if (buffer.length < offset + 8) return null;
    // Only handle up to 32-bit lengths for audio chunks
    payloadLen = buffer.readUInt32BE(offset + 4);
    offset += 8;
  }

  const maskBytes = masked ? 4 : 0;
  if (buffer.length < offset + maskBytes + payloadLen) return null;

  let maskKey;
  if (masked) {
    maskKey = buffer.slice(offset, offset + 4);
    offset += 4;
  }

  const rawPayload = buffer.slice(offset, offset + payloadLen);
  let payload;
  if (masked) {
    payload = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) {
      payload[i] = rawPayload[i] ^ maskKey[i % 4];
    }
  } else {
    payload = rawPayload;
  }

  return { opcode, payload, isFinal, consumed: offset + payloadLen };
}

/**
 * Create a WebSocket text frame (server -> client, no masking).
 * @param {string|object} data  String or object (will be JSON-stringified).
 * @returns {Buffer}
 */
function createWSFrame(data) {
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;

  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text opcode
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }

  return Buffer.concat([header, payload]);
}

/**
 * Create a WebSocket close frame.
 */
function createCloseFrame(code = 1000) {
  const frame = Buffer.alloc(4);
  frame[0] = 0x88; // FIN + close opcode
  frame[1] = 2;
  frame.writeUInt16BE(code, 2);
  return frame;
}

// ── Broadcast helpers ─────────────────────────────────────────────────────────

/**
 * Send a message object to all connected overlay WebSocket clients.
 */
function broadcastOverlay(msg) {
  if (overlayClients.size === 0) return;
  const frame = createWSFrame(msg);
  for (const socket of overlayClients) {
    try {
      socket.write(frame);
    } catch (err) {
      console.log(`[TutorialEngine] broadcastOverlay write error: ${err.message}`);
      overlayClients.delete(socket);
    }
  }
}

// ── State transition ──────────────────────────────────────────────────────────

function canTransition(from, to) {
  const allowed = LEGAL_TRANSITIONS[from];
  return allowed && allowed.includes(to);
}

function transition(newState, context = {}) {
  const from = _currentState;
  if (!canTransition(from, newState)) {
    console.log(`[TutorialEngine] ILLEGAL transition ${from} -> ${newState} (ignored)`);
    return false;
  }
  console.log(`[TutorialEngine] State transition: ${from} -> ${newState}`);
  _currentState = newState;
  updateSession({ state: newState, ...context });
  return true;
}

// ── Timer management ──────────────────────────────────────────────────────────

function clearTimers() {
  if (_listeningTimer) { clearTimeout(_listeningTimer); _listeningTimer = null; }
  if (_repromptTimer)  { clearTimeout(_repromptTimer);  _repromptTimer  = null; }
  if (_reguideTimer)   { clearTimeout(_reguideTimer);   _reguideTimer   = null; }
}

// ── State handlers ────────────────────────────────────────────────────────────

function _handleListening() {
  broadcastOverlay({ type: 'pointer_state', state: 'listening' });

  // 30s timeout -> back to IDLE
  _listeningTimer = setTimeout(() => {
    if (_currentState === TutorialState.LISTENING) {
      console.log('[TutorialEngine] Listening timeout - returning to IDLE');
      broadcastOverlay({ type: 'narrate', text: 'Listening timed out.', duration: 3000 });
      transition(TutorialState.IDLE);
    }
  }, 30000);
}

async function _handlePlanning(transcript) {
  broadcastOverlay({ type: 'pointer_state', state: 'thinking' });

  let planResult;
  try {
    planResult = await planner.planTutorial({ transcript, session: getActiveSession() });
  } catch (err) {
    console.log(`[TutorialEngine] planTutorial threw: ${err.message}`);
    broadcastOverlay({ type: 'narrate', text: 'Sorry, I could not plan that tutorial. Please try again.', duration: 4000 });
    broadcastOverlay({ type: 'engine_error', message: err.message, severity: 'error' });
    transition(TutorialState.IDLE);
    return;
  }

  if (!planResult.ok || !planResult.data || planResult.data.length === 0) {
    const errMsg = planResult.error || 'Plan returned no steps.';
    console.log(`[TutorialEngine] Planning failed: ${errMsg}`);
    broadcastOverlay({ type: 'narrate', text: `Could not create a tutorial: ${errMsg}`, duration: 4000 });
    broadcastOverlay({ type: 'engine_error', message: errMsg, severity: 'warning' });
    transition(TutorialState.IDLE);
    return;
  }

  const steps = planResult.data;
  updateSession({ steps, currentStep: 0 });
  console.log(`[TutorialEngine] Plan ready with ${steps.length} steps`);

  if (transition(TutorialState.GUIDING, { currentStep: 0 })) {
    await _handleGuiding(0);
  }
}

async function _handleGuiding(stepIndex) {
  const session = getActiveSession();
  if (!session || !session.steps || session.steps.length === 0) {
    console.log('[TutorialEngine] _handleGuiding: no session or steps');
    return;
  }

  const step = session.steps[stepIndex];
  if (!step) {
    console.log(`[TutorialEngine] _handleGuiding: step ${stepIndex} not found`);
    return;
  }

  clearTimers();

  broadcastOverlay({ type: 'highlight_clear' });

  // AX-ground target (STUB: use step.targetX/Y if set, else fixed coords)
  const tx = step.targetX != null ? step.targetX : 640;
  const ty = step.targetY != null ? step.targetY : 400;
  const tw = step.targetW != null ? step.targetW : 120;
  const th = step.targetH != null ? step.targetH : 40;

  broadcastOverlay({ type: 'pointer_move', x: tx, y: ty, style: 'default', duration: 600 });
  broadcastOverlay({ type: 'highlight', x: tx, y: ty, w: tw, h: th, style: 'primary' });
  broadcastOverlay({ type: 'annotation', text: step.action, x: tx, y: ty - 50, duration: 8000 });
  broadcastOverlay({ type: 'progress', step: stepIndex + 1, total: session.steps.length, label: step.action });

  await narrator.narrate({ text: step.action, step, broadcastFn: broadcastOverlay });

  // 10s reprompt timer
  let repromptAttempt = 0;
  _repromptTimer = setTimeout(() => {
    if (_currentState === TutorialState.GUIDING) {
      repromptAttempt++;
      const repromptText = planner.generateReprompt(step, repromptAttempt);
      broadcastOverlay({ type: 'narrate', text: repromptText, duration: 4000 });
    }
  }, 10000);

  // 60s re-guide timer -> CORRECTING
  _reguideTimer = setTimeout(() => {
    if (_currentState === TutorialState.GUIDING) {
      console.log('[TutorialEngine] Re-guide timeout - transitioning to CORRECTING');
      clearTimeout(_repromptTimer);
      _repromptTimer = null;
      if (transition(TutorialState.CORRECTING)) {
        _handleCorrecting().catch(err =>
          console.log(`[TutorialEngine] _handleCorrecting error: ${err.message}`)
        );
      }
    }
  }, 60000);
}

async function _handleValidating(clickX, clickY) {
  const session = getActiveSession();
  if (!session) return;

  const stepIndex = session.currentStep || 0;
  const step = session.steps[stepIndex];
  if (!step) return;

  let result;
  try {
    result = await validator.validateStep({ step, stepIndex, clickX, clickY, session });
  } catch (err) {
    console.log(`[TutorialEngine] validateStep threw: ${err.message}`);
    broadcastOverlay({ type: 'engine_error', message: err.message, severity: 'warning' });
    if (transition(TutorialState.CORRECTING)) {
      await _handleCorrecting();
    }
    return;
  }

  if (!result.ok) {
    console.log(`[TutorialEngine] Validation error: ${result.error}`);
    broadcastOverlay({ type: 'engine_error', message: result.error || 'Validation failed', severity: 'warning' });
    if (transition(TutorialState.CORRECTING)) {
      await _handleCorrecting();
    }
    return;
  }

  const { verdict } = result.data;
  console.log(`[TutorialEngine] Validation verdict: ${verdict} for step ${stepIndex + 1}`);

  if (verdict === 'correct') {
    const nextIndex = stepIndex + 1;
    if (nextIndex >= session.steps.length) {
      // Last step completed
      if (transition(TutorialState.COMPLETED)) {
        await _handleCompleted();
      }
    } else {
      updateSession({ currentStep: nextIndex });
      if (transition(TutorialState.GUIDING, { currentStep: nextIndex })) {
        await _handleGuiding(nextIndex);
      }
    }
  } else {
    if (transition(TutorialState.CORRECTING)) {
      await _handleCorrecting();
    }
  }
}

async function _handleCorrecting() {
  const session = getActiveSession();
  if (!session) return;

  const stepIndex = session.currentStep || 0;
  const step = session.steps[stepIndex];

  let correctionResult;
  try {
    correctionResult = await planner.generateCorrection({ step, stepIndex, session });
  } catch (err) {
    correctionResult = { ok: true, data: 'Try clicking the highlighted element.', error: null };
  }

  const correctionText = (correctionResult.ok && correctionResult.data) ? correctionResult.data : 'Try clicking the highlighted element.';
  broadcastOverlay({ type: 'narrate', text: correctionText, duration: 5000 });

  // Brief error state then back to guide
  broadcastOverlay({ type: 'pointer_state', state: 'error' });
  await _delay(200);

  updateSession({ errorCount: (session.errorCount || 0) + 1 });

  if (transition(TutorialState.GUIDING)) {
    await _handleGuiding(session.currentStep || 0);
  }
}

async function _handleCompleted() {
  broadcastOverlay({ type: 'pointer_state', state: 'success' });
  broadcastOverlay({ type: 'narrate', text: 'Tutorial complete!', duration: 3000 });
  await narrator.narrate({ text: 'Tutorial complete!', broadcastFn: broadcastOverlay });

  completeSession();

  setTimeout(() => {
    broadcastOverlay({ type: 'dismiss' });
    if (canTransition(_currentState, TutorialState.IDLE)) {
      console.log('[TutorialEngine] Auto-transitioning COMPLETED -> IDLE');
      _currentState = TutorialState.IDLE;
    }
  }, 3000);
}

// ── Audio (Wave 1 stub) ───────────────────────────────────────────────────────

function _handleAudioChunk(base64Data) {
  _audioBuffer.push(base64Data);
}

async function _handleAudioEnd() {
  // Wave 1 stub: ignore actual audio, return hardcoded transcript
  const transcript = 'Open Safari';
  _audioBuffer = [];
  console.log(`[TutorialEngine] Audio end - stub transcript: "${transcript}"`);

  updateSession({ transcription: transcript });

  if (transition(TutorialState.PLANNING)) {
    await _handlePlanning(transcript);
  }
}

// ── Incoming overlay message dispatch ────────────────────────────────────────

async function _handleOverlayMessage(msg) {
  const { type } = msg;

  switch (type) {
    case 'cursor_position':
      // Store cursor position for idle tracking - no action needed
      break;

    case 'hotkey_activated':
      if (_currentState === TutorialState.IDLE) {
        if (!getActiveSession()) {
          createSession('', []);
        }
        clearTimers();
        if (transition(TutorialState.LISTENING)) {
          _handleListening();
        }
      }
      break;

    case 'hotkey_deactivated':
      if (_currentState === TutorialState.LISTENING) {
        clearTimers();
        transition(TutorialState.IDLE);
      }
      break;

    case 'audio_chunk':
      if (_currentState === TutorialState.LISTENING && msg.data) {
        _handleAudioChunk(msg.data);
      }
      break;

    case 'audio_end':
      if (_currentState === TutorialState.LISTENING) {
        clearTimers();
        await _handleAudioEnd();
      }
      break;

    case 'user_clicked':
      if (_currentState === TutorialState.GUIDING) {
        clearTimers();
        if (transition(TutorialState.VALIDATING)) {
          await _handleValidating(msg.x, msg.y);
        }
      }
      break;

    default:
      console.log(`[TutorialEngine] Unknown overlay message type: ${type}`);
  }
}

// ── WebSocket upgrade handler ─────────────────────────────────────────────────

function handleUpgrade(req, socket, head) {
  if (req.url !== '/tutorial/ws') {
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const acceptKey = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-5AB5DC11A5B5')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + acceptKey + '\r\n\r\n'
  );

  console.log('[TutorialEngine] Overlay WebSocket client connected');
  overlayClients.add(socket);

  let frameBuffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    frameBuffer = Buffer.concat([frameBuffer, chunk]);

    while (frameBuffer.length >= 2) {
      const frame = parseWSFrame(frameBuffer);
      if (!frame) break; // need more data

      frameBuffer = frameBuffer.slice(frame.consumed);

      // opcode 8 = close
      if (frame.opcode === 8) {
        socket.write(createCloseFrame(1000));
        socket.end();
        return;
      }

      // opcode 9 = ping -> send pong (opcode 10)
      if (frame.opcode === 9) {
        const pong = Buffer.alloc(2);
        pong[0] = 0x8a;
        pong[1] = 0;
        socket.write(pong);
        continue;
      }

      // opcode 1 = text
      if (frame.opcode === 1) {
        const text = frame.payload.toString('utf8');
        let msg;
        try {
          msg = JSON.parse(text);
        } catch (err) {
          console.log(`[TutorialEngine] WS JSON parse error: ${err.message}`);
          continue;
        }
        _handleOverlayMessage(msg).catch(err =>
          console.log(`[TutorialEngine] Overlay message handler error: ${err.message}`)
        );
      }

      // opcode 2 = binary (audio_chunk data handled as text JSON above)
    }
  });

  socket.on('close', () => {
    console.log('[TutorialEngine] Overlay WebSocket client disconnected');
    overlayClients.delete(socket);
  });

  socket.on('error', (err) => {
    console.log(`[TutorialEngine] WebSocket socket error: ${err.message}`);
    overlayClients.delete(socket);
  });
}

// ── HTTP request helpers ──────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendNoContent(res) {
  res.writeHead(204);
  res.end();
}

// ── Route handlers ────────────────────────────────────────────────────────────

async function handleStart(req, res) {
  // req.body is already parsed by module-loader's expressify adapter
  const body = req.body || {};

  const userRequest = (body.request || '').trim();
  if (!userRequest) {
    return sendJSON(res, 400, { error: 'request field is required' });
  }

  // Cancel any existing session
  const existing = getActiveSession();
  if (existing) {
    cancelSession('Superseded by new tutorial request');
  }

  const session = createSession(userRequest, []);
  console.log(`[TutorialEngine] POST /tutorial/start - "${userRequest}"`);

  // Kick off planning directly (no audio needed when called via HTTP)
  clearTimers();
  _currentState = TutorialState.PLANNING;
  updateSession({ state: TutorialState.PLANNING, transcription: userRequest });

  // Run planning async (don't await - let HTTP return immediately)
  _handlePlanning(userRequest).catch(err =>
    console.log(`[TutorialEngine] Planning error after /start: ${err.message}`)
  );

  return sendJSON(res, 200, session);
}

async function handleCancel(req, res) {
  const session = getActiveSession();
  if (!session) {
    return sendJSON(res, 200, { ok: true, message: 'No active session' });
  }

  clearTimers();
  narrator.stopAudio();
  const cancelled = cancelSession('User requested cancellation');
  _currentState = TutorialState.IDLE;
  broadcastOverlay({ type: 'dismiss' });

  console.log('[TutorialEngine] POST /tutorial/cancel');
  return sendJSON(res, 200, { ok: true, session: cancelled });
}

function handleGetSession(req, res) {
  const session = getActiveSession();
  if (!session) {
    return sendNoContent(res);
  }
  return sendJSON(res, 200, session);
}

function handleGetHistory(req, res) {
  const history = getHistory();
  return sendJSON(res, 200, history);
}

// ── Mount functions ───────────────────────────────────────────────────────────

/**
 * Register tutorial HTTP routes on the Atlas app object.
 * Atlas module-loader provides app.get(path, handler) and app.post(path, handler).
 * @param {object} app  Atlas Express-like app.
 */
function mountTutorialRoutes(app) {
  app.post('/tutorial/start',   (req, res) => handleStart(req, res).catch(err => {
    console.log(`[TutorialEngine] /tutorial/start error: ${err.message}`);
    sendJSON(res, 500, { error: err.message });
  }));

  app.post('/tutorial/cancel',  (req, res) => handleCancel(req, res).catch(err => {
    console.log(`[TutorialEngine] /tutorial/cancel error: ${err.message}`);
    sendJSON(res, 500, { error: err.message });
  }));

  app.get('/tutorial/session',  (req, res) => handleGetSession(req, res));
  app.get('/tutorial/history',  (req, res) => handleGetHistory(req, res));

  console.log('[TutorialEngine] HTTP routes mounted: /tutorial/{start,cancel,session,history}');
}

/**
 * Attach the WebSocket upgrade handler to the raw http.Server.
 * @param {import('http').Server} server
 */
function mountWebSocket(server) {
  server.on('upgrade', handleUpgrade);
  console.log('[TutorialEngine] WebSocket upgrade handler mounted on /tutorial/ws');
}

// ── Utility ───────────────────────────────────────────────────────────────────

function _delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  mountTutorialRoutes,
  mountWebSocket,
  // Exported for testing
  broadcastOverlay,
  parseWSFrame,
  createWSFrame,
  TutorialState,
};
