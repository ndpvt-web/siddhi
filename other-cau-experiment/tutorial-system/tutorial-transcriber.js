'use strict';

/**
 * tutorial-transcriber.js
 * Speech-to-text module. Handles audio from the overlay and produces transcriptions.
 *
 * Strategy:
 * 1. If Whisper.cpp binary available: spawn it on PCM audio
 * 2. If not: fall back to hardcoded transcript (dev mode)
 *
 * Listens for bus events:
 *   'audio_chunk' { data: base64 } -- accumulates PCM chunks (WS path)
 *   'audio_end' {}                  -- finishes WS-path audio, transcribes
 *   'audio_pcm' { buffer: Buffer }  -- complete PCM from HTTP POST path
 *
 * Emits:
 *   'transcription' { text: String }
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const bus = require('./tutorial-bus');

// ── Configuration ──────────────────────────────────────────────────────────

const WHISPER_PATH = process.env.ATLAS_WHISPER_PATH || '/usr/local/bin/whisper-cpp';
const WHISPER_MODEL = process.env.ATLAS_WHISPER_MODEL || path.join(
  process.env.HOME || '/tmp',
  '.whisper/models/ggml-base.en.bin'
);
const FALLBACK_TRANSCRIPT = 'Open Safari'; // dev fallback when Whisper not available

// ── Audio buffer for WS chunk path ──────────────────────────────────────────

let _audioChunks = [];

// ── Whisper detection ──────────────────────────────────────────────────────

let _whisperAvailable = null;

function isWhisperAvailable() {
  if (_whisperAvailable !== null) return _whisperAvailable;
  try {
    _whisperAvailable = fs.existsSync(WHISPER_PATH) && fs.existsSync(WHISPER_MODEL);
  } catch (_) {
    _whisperAvailable = false;
  }
  if (_whisperAvailable) {
    console.log(`[Transcriber] Whisper.cpp available at ${WHISPER_PATH}`);
  } else {
    console.log(`[Transcriber] Whisper.cpp not found -- using fallback transcript`);
  }
  return _whisperAvailable;
}

// ── Transcription ──────────────────────────────────────────────────────────

/**
 * Transcribe a PCM buffer (16kHz, mono, 16-bit signed LE).
 * Returns the transcript string.
 */
function transcribePCM(pcmBuffer) {
  return new Promise((resolve) => {
    if (!isWhisperAvailable()) {
      console.log(`[Transcriber] Using fallback transcript: "${FALLBACK_TRANSCRIPT}"`);
      resolve(FALLBACK_TRANSCRIPT);
      return;
    }

    // Write PCM to a temp WAV file (Whisper.cpp expects WAV)
    const tmpWav = `/tmp/atlas-stt-${Date.now()}.wav`;
    const wavBuffer = pcmToWav(pcmBuffer, 16000, 1, 16);
    fs.writeFileSync(tmpWav, wavBuffer);

    const proc = spawn(WHISPER_PATH, [
      '-m', WHISPER_MODEL,
      '-f', tmpWav,
      '-otxt',
      '-nt',        // no timestamps
      '--no-prints', // suppress progress
    ], {
      timeout: 15000,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      // Clean up temp file
      try { fs.unlinkSync(tmpWav); } catch (_) {}

      if (code === 0 && stdout.trim()) {
        const text = stdout.trim();
        console.log(`[Transcriber] Whisper result: "${text}"`);
        resolve(text);
      } else {
        console.log(`[Transcriber] Whisper failed (code=${code}): ${stderr.slice(0, 200)}`);
        // Check for .txt output file (whisper-cpp writes <input>.txt)
        const txtFile = tmpWav + '.txt';
        try {
          if (fs.existsSync(txtFile)) {
            const text = fs.readFileSync(txtFile, 'utf8').trim();
            fs.unlinkSync(txtFile);
            if (text) {
              console.log(`[Transcriber] Whisper .txt result: "${text}"`);
              resolve(text);
              return;
            }
          }
        } catch (_) {}

        console.log(`[Transcriber] Falling back to: "${FALLBACK_TRANSCRIPT}"`);
        resolve(FALLBACK_TRANSCRIPT);
      }
    });

    proc.on('error', (err) => {
      console.log(`[Transcriber] Whisper spawn error: ${err.message}`);
      try { fs.unlinkSync(tmpWav); } catch (_) {}
      resolve(FALLBACK_TRANSCRIPT);
    });
  });
}

/**
 * Convert raw PCM to WAV format.
 */
function pcmToWav(pcmBuffer, sampleRate, channels, bitsPerSample) {
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcmBuffer.length;
  const headerSize = 44;

  const wav = Buffer.alloc(headerSize + dataSize);

  // RIFF header
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);

  // fmt chunk
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);           // chunk size
  wav.writeUInt16LE(1, 20);            // PCM format
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 30);
  wav.writeUInt16LE(bitsPerSample, 32);

  // data chunk
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  pcmBuffer.copy(wav, 44);

  return wav;
}

// ── Bus subscriptions ──────────────────────────────────────────────────────

bus.on('audio_chunk', ({ data }) => {
  if (data) {
    _audioChunks.push(Buffer.from(data, 'base64'));
  }
});

bus.on('audio_end', () => {
  const pcm = _audioChunks.length > 0 ? Buffer.concat(_audioChunks) : Buffer.alloc(0);
  _audioChunks = [];

  if (pcm.length === 0) {
    console.log('[Transcriber] audio_end with empty buffer -- using fallback');
    bus.emit('transcription', { text: FALLBACK_TRANSCRIPT });
    return;
  }

  transcribePCM(pcm).then((text) => {
    bus.emit('transcription', { text: text || FALLBACK_TRANSCRIPT });
  });
});

bus.on('audio_pcm', ({ buffer }) => {
  if (!buffer || buffer.length === 0) {
    bus.emit('transcription', { text: FALLBACK_TRANSCRIPT });
    return;
  }

  transcribePCM(buffer).then((text) => {
    bus.emit('transcription', { text: text || FALLBACK_TRANSCRIPT });
  });
});

module.exports = { transcribePCM, isWhisperAvailable };
