'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── Constants ────────────────────────────────────────────────────────────────

const TutorialState = {
  IDLE:        'IDLE',
  LISTENING:   'LISTENING',
  PLANNING:    'PLANNING',
  GUIDING:     'GUIDING',
  VALIDATING:  'VALIDATING',
  CORRECTING:  'CORRECTING',
  COMPLETED:   'COMPLETED',
  CANCELLED:   'CANCELLED',
};

const DATA_DIR = process.env.ATLAS_DATA_DIR || path.join(__dirname, '../../atlas-data');
const SESSIONS_DIR = path.join(DATA_DIR, 'tutorial-sessions');
const MAX_HISTORY = 20;

// ── In-memory store ──────────────────────────────────────────────────────────

let _activeSession = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function ensureSessionsDir() {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    console.log(`[TutorialSession] Created sessions directory: ${SESSIONS_DIR}`);
  }
}

function sessionFilePath(sessionId) {
  return path.join(SESSIONS_DIR, `${sessionId}.json`);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a new TutorialSession and set it as the active session.
 * @param {string} userRequest  Raw text of what the user asked to learn.
 * @param {Array}  steps        Array of planned step objects (may be empty initially).
 * @returns {object} The newly created session.
 */
function createSession(userRequest, steps = []) {
  const session = {
    sessionId:        crypto.randomUUID(),
    userRequest:      userRequest || '',
    state:            TutorialState.IDLE,
    steps:            steps,
    currentStep:      0,
    startedAt:        new Date().toISOString(),
    completedAt:      null,
    cancelReason:     null,
    errorCount:       0,
    planningContext:  null,
    transcription:    null,
  };

  _activeSession = session;
  persistSession(session);
  console.log(`[TutorialSession] Created session ${session.sessionId} for request: "${userRequest}"`);
  return session;
}

/**
 * Returns the current active session, or null if none exists.
 * @returns {object|null}
 */
function getActiveSession() {
  return _activeSession;
}

/**
 * Merge `updates` into the active session and persist.
 * @param {object} updates  Partial session fields to merge.
 * @returns {object|null}   Updated session, or null if no active session.
 */
function updateSession(updates) {
  if (!_activeSession) {
    console.log('[TutorialSession] updateSession called with no active session');
    return null;
  }

  Object.assign(_activeSession, updates);
  persistSession(_activeSession);
  return _activeSession;
}

/**
 * Mark the active session as COMPLETED.
 * @returns {object|null}
 */
function completeSession() {
  if (!_activeSession) {
    console.log('[TutorialSession] completeSession called with no active session');
    return null;
  }

  _activeSession.completedAt = new Date().toISOString();
  _activeSession.state = TutorialState.COMPLETED;
  persistSession(_activeSession);
  console.log(`[TutorialSession] Session ${_activeSession.sessionId} completed`);

  const completed = _activeSession;
  _activeSession = null;
  return completed;
}

/**
 * Mark the active session as CANCELLED with an optional reason.
 * @param {string} reason
 * @returns {object|null}
 */
function cancelSession(reason = '') {
  if (!_activeSession) {
    console.log('[TutorialSession] cancelSession called with no active session');
    return null;
  }

  _activeSession.state = TutorialState.CANCELLED;
  _activeSession.cancelReason = reason;
  _activeSession.completedAt = new Date().toISOString();
  persistSession(_activeSession);
  console.log(`[TutorialSession] Session ${_activeSession.sessionId} cancelled: ${reason}`);

  const cancelled = _activeSession;
  _activeSession = null;
  return cancelled;
}

/**
 * Return up to the last 20 sessions sorted by startedAt descending.
 * Reads from the sessions directory on disk.
 * @returns {Array}
 */
function getHistory() {
  ensureSessionsDir();

  let files;
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
  } catch (err) {
    console.log(`[TutorialSession] getHistory read error: ${err.message}`);
    return [];
  }

  const sessions = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8');
      sessions.push(JSON.parse(raw));
    } catch (err) {
      console.log(`[TutorialSession] Failed to parse session file ${file}: ${err.message}`);
    }
  }

  sessions.sort((a, b) => {
    const ta = a.startedAt ? new Date(a.startedAt).getTime() : 0;
    const tb = b.startedAt ? new Date(b.startedAt).getTime() : 0;
    return tb - ta;
  });

  return sessions.slice(0, MAX_HISTORY);
}

/**
 * Write a session object to disk as JSON.
 * @param {object} session
 */
function persistSession(session) {
  ensureSessionsDir();
  const filePath = sessionFilePath(session.sessionId);
  try {
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf8');
  } catch (err) {
    console.log(`[TutorialSession] Failed to persist session ${session.sessionId}: ${err.message}`);
  }
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  TutorialState,
  createSession,
  getActiveSession,
  updateSession,
  completeSession,
  cancelSession,
  getHistory,
  persistSession,
};
