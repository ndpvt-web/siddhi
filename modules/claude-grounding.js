/**
 * claude-grounding.js - Claude Vision API coordinate grounding
 * 
 * Drop-in replacement for ShowUI-2B grounding worker.
 * Uses Claude Sonnet 4.6 via AI Gateway Bedrock to locate UI elements
 * from screenshots with natural language queries.
 *
 * Interface matches queryShowUI():
 *   Input:  imagePath, query, screenW, screenH, timeoutMs
 *   Output: {coords: [x,y], pixels: [px,py], elapsed_ms} | null
 *
 * Architecture (Aristotelian):
 *   Material: Screenshot (JPEG) + element description (text)
 *   Formal:   Claude Vision -> normalized [x,y] coordinates
 *   Efficient: Single API call to Bedrock gateway (~800-1500ms)
 *   Final:     Pixel-accurate click target for cliclick
 */

'use strict';

const https = require('https');
const fs = require('fs');

// AI Gateway config (same as computer-use.js)
const AI_GATEWAY_HOST = 'ai-gateway.happycapy.ai';
const AI_GATEWAY_KEY = process.env.AI_GATEWAY_API_KEY || 'cc00f875633a4dca884e24f5ab6e0106';
const MODEL_PATH = '/api/v1/bedrock/model/claude-sonnet-4-6/invoke';

// Stats tracking (mirrors ShowUI stats interface)
const stats = { queries: 0, refined: 0, totalMs: 0, failures: 0 };

const GROUNDING_PROMPT = `You are a precise UI element locator. Given a screenshot and an element description, return the EXACT center coordinates of that element.

Rules:
- Return coordinates as normalized values between 0 and 1 (relative to image dimensions)
- x=0 is left edge, x=1 is right edge
- y=0 is top edge, y=1 is bottom edge  
- Return ONLY a JSON object: {"x": 0.XX, "y": 0.YY}
- If you cannot find the element, return: {"x": -1, "y": -1}
- Be precise - aim for the clickable center of the element`;

/**
 * Query Claude Vision for element coordinates.
 * Drop-in replacement for queryShowUI().
 * 
 * @param {string} imagePath - Path to screenshot JPEG
 * @param {string} query - Element description ("the submit button")
 * @param {number} screenW - Screen width in pixels
 * @param {number} screenH - Screen height in pixels  
 * @param {number} timeoutMs - Max wait (default 5000ms)
 * @returns {Promise<{coords:[number,number], pixels:[number,number], elapsed_ms:number}|null>}
 */
function queryClaudeGrounding(imagePath, query, screenW, screenH, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    stats.queries++;

    // Read image as base64
    let imageData;
    try {
      const raw = fs.readFileSync(imagePath);
      imageData = raw.toString('base64');
    } catch (e) {
      console.log('[ClaudeGrounding] Failed to read image: ' + e.message);
      stats.failures++;
      resolve(null);
      return;
    }

    const payload = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageData } },
          { type: 'text', text: GROUNDING_PROMPT + '\n\nFind this element: "' + query + '"' }
        ]
      }]
    });

    const timer = setTimeout(() => {
      console.log('[ClaudeGrounding] Timeout after ' + timeoutMs + 'ms');
      stats.failures++;
      resolve(null);
    }, timeoutMs);

    const req = https.request({
      hostname: AI_GATEWAY_HOST,
      port: 443,
      path: MODEL_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + AI_GATEWAY_KEY,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        clearTimeout(timer);
        const elapsed = Date.now() - t0;

        if (res.statusCode >= 400) {
          console.log('[ClaudeGrounding] API error ' + res.statusCode + ': ' + body.slice(0, 200));
          stats.failures++;
          resolve(null);
          return;
        }

        try {
          const resp = JSON.parse(body);
          const text = resp.content?.[0]?.text || '';
          
          // Parse JSON coordinates from response
          const match = text.match(/\{[^}]*"x"\s*:\s*([\d.]+)[^}]*"y"\s*:\s*([\d.]+)[^}]*/);
          if (!match) {
            console.log('[ClaudeGrounding] Could not parse coords from: ' + text.slice(0, 100));
            stats.failures++;
            resolve(null);
            return;
          }

          const nx = parseFloat(match[1]);
          const ny = parseFloat(match[2]);

          // Check for "not found" signal
          if (nx < 0 || ny < 0) {
            console.log('[ClaudeGrounding] Element not found: "' + query + '"');
            stats.failures++;
            resolve(null);
            return;
          }

          // Validate range
          if (nx < 0 || nx > 1 || ny < 0 || ny > 1) {
            console.log('[ClaudeGrounding] Coords out of range: [' + nx + ', ' + ny + ']');
            stats.failures++;
            resolve(null);
            return;
          }

          const px = Math.round(nx * screenW);
          const py = Math.round(ny * screenH);

          stats.totalMs += elapsed;
          stats.refined++;

          console.log('[ClaudeGrounding] Found "' + query + '" at [' + nx.toFixed(3) + ', ' + ny.toFixed(3) + '] -> (' + px + ', ' + py + ') in ' + elapsed + 'ms');

          resolve({
            coords: [nx, ny],
            pixels: [px, py],
            elapsed_ms: elapsed,
            text: text,
          });
        } catch (e) {
          console.log('[ClaudeGrounding] Parse error: ' + e.message);
          stats.failures++;
          resolve(null);
        }
      });
    });

    req.on('error', (e) => {
      clearTimeout(timer);
      console.log('[ClaudeGrounding] Request error: ' + e.message);
      stats.failures++;
      resolve(null);
    });

    req.write(payload);
    req.end();
  });
}

function getStats() { return { ...stats }; }
function resetStats() { stats.queries = 0; stats.refined = 0; stats.totalMs = 0; stats.failures = 0; }

module.exports = { queryClaudeGrounding, getStats, resetStats };
