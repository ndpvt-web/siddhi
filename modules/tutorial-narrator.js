'use strict';

/**
 * tutorial-narrator.js
 * Non-blocking TTS with pre-generation cache.
 * Subtitle delivery is immediate and independent of audio generation.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const bus = require('./tutorial-bus');

// ── Module state ─────────────────────────────────────────────────────────────

let _currentAudioProcess = null;
let _currentTempFile = null;

/** @type {Map<number, { wavPath: string|null, promise: Promise|null }>} */
const _ttsCache = new Map();

// ── Markdown stripping ─────────────────────────────────────────────────────

function stripMarkdown(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/[*_~`]/g, '')
    .trim();
}

// ── Subtitle duration estimate ──────────────────────────────────────────────

function estimateDuration(text) {
  const raw = (text || '').length * 60;
  return Math.min(Math.max(raw, 2000), 10000);
}

// ── HTTP helper ─────────────────────────────────────────────────────────────

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const payload = JSON.stringify(body);

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    };

    const token = process.env.CAPY_BRIDGE_TOKEN;
    if (token && parsed.hostname === 'localhost') {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method: 'POST',
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(buf);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${buf.toString('utf8').slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('TTS request timed out')));
    req.write(payload);
    req.end();
  });
}

// ── File cleanup ────────────────────────────────────────────────────────────

function cleanupTempFile(filePath) {
  if (!filePath) return;
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
}

// ── Audio playback ──────────────────────────────────────────────────────────

function playWav(wavPath) {
  if (!wavPath || !fs.existsSync(wavPath)) return;

  // Stop any currently playing audio
  stopCurrentAudio();

  let proc;
  try {
    proc = spawn('afplay', [wavPath], { stdio: 'ignore', detached: false });
  } catch (_) {
    cleanupTempFile(wavPath);
    return;
  }

  _currentAudioProcess = proc;
  _currentTempFile = wavPath;

  proc.on('close', () => {
    if (_currentAudioProcess === proc) {
      _currentAudioProcess = null;
    }
    cleanupTempFile(wavPath);
    if (_currentTempFile === wavPath) _currentTempFile = null;
  });

  proc.on('error', () => {
    if (_currentAudioProcess === proc) {
      _currentAudioProcess = null;
    }
    cleanupTempFile(wavPath);
    if (_currentTempFile === wavPath) _currentTempFile = null;
  });
}

function stopCurrentAudio() {
  if (_currentAudioProcess) {
    try { _currentAudioProcess.kill('SIGTERM'); } catch (_) {}
    _currentAudioProcess = null;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Send subtitle to overlay immediately. Synchronous, never blocks.
 * @param {string} text
 * @param {function} broadcastFn
 */
function broadcastSubtitle(text, broadcastFn) {
  if (typeof broadcastFn !== 'function') return;
  const duration = estimateDuration(text);
  try {
    broadcastFn({ type: 'narrate', text, duration });
  } catch (err) {
    console.log(`[Narrator] broadcastSubtitle error: ${err.message}`);
  }
}

/**
 * Enqueue TTS generation for a step. Non-blocking -- returns immediately.
 * When TTS completes, emits 'tts_ready' on the bus.
 * Results are cached by stepIndex for pre-generation.
 *
 * @param {object} step - TutorialStep (needs step.action)
 * @param {number} index - step index (-1 for completion message)
 */
function enqueue(step, index) {
  const text = stripMarkdown(step.action || step.text || '');
  if (!text) return;

  // Already generating or cached?
  if (_ttsCache.has(index)) return;

  const kokoroUrl = process.env.KOKORO_URL || 'http://localhost:7892/tts';

  const promise = httpPost(kokoroUrl, {
    text,
    voice: 'af_heart',
    stream: false,
  }).then((wavBuffer) => {
    const tmpPath = `/tmp/atlas-tts-${Date.now()}-${index}.wav`;
    fs.writeFileSync(tmpPath, wavBuffer);

    const entry = _ttsCache.get(index);
    if (entry) entry.wavPath = tmpPath;

    bus.emit('tts_ready', { index, wavPath: tmpPath });
    return tmpPath;
  }).catch((err) => {
    console.log(`[Narrator] TTS error for step ${index}: ${err.message}`);
    _ttsCache.delete(index);
    bus.emit('tts_error', { index, message: err.message });
    return null;
  });

  _ttsCache.set(index, { wavPath: null, promise });
}

/**
 * Play pre-generated TTS for a step if it's ready.
 * If still generating, the bus 'tts_ready' event will trigger playback.
 *
 * @param {number} index
 */
function playIfReady(index) {
  const entry = _ttsCache.get(index);
  if (!entry) return;
  if (entry.wavPath) {
    playWav(entry.wavPath);
    _ttsCache.delete(index);
  }
  // If not ready yet, tts_ready bus event will handle it (engine listens)
}

/**
 * Stop all audio and clear TTS cache.
 */
function stopAudio() {
  stopCurrentAudio();

  // Clean up temp files
  if (_currentTempFile) {
    cleanupTempFile(_currentTempFile);
    _currentTempFile = null;
  }

  // Clean cached WAV files
  for (const [, entry] of _ttsCache) {
    if (entry.wavPath) cleanupTempFile(entry.wavPath);
  }
  _ttsCache.clear();

  // Sweep any leftover temp files
  try {
    const files = fs.readdirSync('/tmp').filter(f => f.startsWith('atlas-tts-') && f.endsWith('.wav'));
    for (const f of files) cleanupTempFile(path.join('/tmp', f));
  } catch (_) {}
}

module.exports = {
  broadcastSubtitle,
  enqueue,
  playIfReady,
  playWav,
  stopAudio,
};
