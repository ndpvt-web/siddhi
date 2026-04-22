'use strict';

/**
 * YouTube Transcript Extractor
 *
 * Multi-strategy approach:
 *   1. Direct innertube API (fastest, works for videos with manual/ASR captions visible to server IPs)
 *   2. TinyFish Agent via residential proxy (slower, but can access auto-generated captions)
 *   3. Graceful degradation to empty transcript (caller uses chapters + description instead)
 *
 * Dependency: youtube-transcript npm package (installed alongside this module)
 */

const https = require('https');
const path = require('path');
const fs = require('fs');

// ─── Load youtube-transcript CJS build ───────────────────────────
// The package is ESM-only but ships a CJS dist file
let YoutubeTranscript = null;
try {
  const cjsPath = path.join(__dirname, 'node_modules', 'youtube-transcript', 'dist', 'youtube-transcript.common.js');
  if (fs.existsSync(cjsPath)) {
    const code = fs.readFileSync(cjsPath, 'utf8');
    const m = {};
    new Function('exports', 'require', '__dirname', '__filename', code)(m, require, __dirname, __filename);
    YoutubeTranscript = m.YoutubeTranscript;
  }
} catch (_) { /* package not installed — strategy 1 unavailable */ }

// ─── Helpers ─────────────────────────────────────────────────────

function extractVideoId(urlOrId) {
  if (/^[a-zA-Z0-9_-]{11}$/.test(urlOrId)) return urlOrId;
  const match = urlOrId.match(/(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?/\s]{11})/i);
  return match ? match[1] : null;
}

function formatTime(ms) {
  const s = ms / 1000;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

// ─── Strategy 1: youtube-transcript package ──────────────────────
// Uses innertube Android API + web page fallback internally

async function fetchViaPackage(videoId, lang) {
  if (!YoutubeTranscript) return null;

  try {
    const entries = await YoutubeTranscript.fetchTranscript(videoId, { lang: lang || 'en' });
    if (!entries || !entries.length) return null;

    return entries.map(e => ({
      time: formatTime(e.offset || 0),
      offsetMs: e.offset || 0,
      duration: e.duration || 0,
      text: (e.text || '').trim(),
    })).filter(e => e.text);
  } catch (_) {
    // "Transcript is disabled" / "too many requests" / etc.
    return null;
  }
}

// ─── Strategy 2: TinyFish Agent (residential IP) ─────────────────
// Uses browser automation to click "Show transcript" on YouTube

async function fetchViaTinyFish(videoId, opts = {}) {
  const apiKey = opts.tinyfishApiKey || process.env.TINYFISH_API_KEY;
  if (!apiKey) return null;

  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const goal = `Go to this YouTube video page. Click "...more" under the description to expand it. ` +
    `Then look for a "Show transcript" button and click it. Wait for the transcript panel to open. ` +
    `Extract ALL the transcript text with timestamps. Return as JSON: ` +
    `{"transcript": [{"time": "0:00", "text": "..."}]}. ` +
    `If no transcript button exists, return {"transcript": [], "error": "no transcript available"}.`;

  try {
    const body = JSON.stringify({ url, goal, proxy_config: { enabled: true } });

    const result = await new Promise((resolve, reject) => {
      const u = new URL('https://agent.tinyfish.ai/v1/automation/run');
      const req = https.request({
        hostname: u.hostname,
        path: u.pathname,
        method: 'POST',
        headers: {
          'X-API-Key': apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: opts.timeout || 120000,
      }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (_) { resolve(null); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(body);
      req.end();
    });

    if (!result || !result.result) return null;

    // Normalize TinyFish's varied response shapes
    let transcript = [];
    const r = result.result;
    if (r.transcript && Array.isArray(r.transcript)) {
      transcript = r.transcript;
    } else if (Array.isArray(r)) {
      transcript = r;
    } else {
      // Search for any array in the result
      for (const val of Object.values(r)) {
        if (Array.isArray(val) && val.length > 0 && (val[0].time || val[0].timestamp || val[0].text)) {
          transcript = val;
          break;
        }
      }
    }

    return transcript.map(e => ({
      time: e.time || e.timestamp || '0:00',
      offsetMs: parseTimeToMs(e.time || e.timestamp || '0:00'),
      duration: 0,
      text: (e.text || e.content || '').trim(),
    })).filter(e => e.text);
  } catch (_) {
    return null;
  }
}

function parseTimeToMs(timeStr) {
  const parts = String(timeStr).split(':').map(Number);
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  return 0;
}

// ─── Main API ────────────────────────────────────────────────────

/**
 * Extract transcript from a YouTube video.
 *
 * @param {string} videoUrlOrId  YouTube URL or 11-char video ID
 * @param {object} [opts]
 * @param {string} [opts.lang]          Preferred language (default: 'en')
 * @param {string} [opts.tinyfishApiKey] TinyFish API key (falls back to env)
 * @param {boolean} [opts.skipTinyFish]  Skip the TinyFish strategy
 * @param {number} [opts.timeout]        TinyFish timeout in ms (default: 120000)
 * @returns {{ ok: boolean, transcript: Array, source: string, error?: string }}
 */
async function extractTranscript(videoUrlOrId, opts = {}) {
  const videoId = extractVideoId(videoUrlOrId);
  if (!videoId) {
    return { ok: false, transcript: [], source: 'none', error: 'Invalid video URL or ID' };
  }

  // Strategy 1: youtube-transcript package (fast, free)
  const direct = await fetchViaPackage(videoId, opts.lang);
  if (direct && direct.length > 0) {
    return { ok: true, transcript: direct, source: 'innertube', videoId };
  }

  // Strategy 2: TinyFish Agent (residential proxy, slower)
  if (!opts.skipTinyFish) {
    const tf = await fetchViaTinyFish(videoId, opts);
    if (tf && tf.length > 0) {
      return { ok: true, transcript: tf, source: 'tinyfish', videoId };
    }
  }

  // All strategies failed
  return {
    ok: false,
    transcript: [],
    source: 'none',
    videoId,
    error: 'Could not extract transcript. Video may not have captions, or access is restricted.',
  };
}

/**
 * Check if the youtube-transcript package is available.
 */
function isPackageAvailable() {
  return !!YoutubeTranscript;
}

module.exports = {
  extractTranscript,
  extractVideoId,
  isPackageAvailable,
};
