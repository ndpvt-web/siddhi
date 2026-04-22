/**
 * Capy Macro - LLM Auto-Naming
 * Phase 4: Generate concise macro names using Claude Haiku.
 * Cost: ~$0.001 per naming call.
 */

const https = require('https');

const AI_GATEWAY_HOST = 'ai-gateway.happycapy.ai';
const AI_GATEWAY_KEY = 'cc00f875633a4dca884e24f5ab6e0106';

/**
 * Generate a concise 3-6 word macro name using Claude Haiku.
 * Falls back to pattern-based name on timeout/error.
 */
async function generateMacroNameLLM(steps, options = {}) {
  const { apiKey = AI_GATEWAY_KEY, timeout = 3000 } = options;
  if (!steps?.length) return 'Untitled Macro';

  const summary = extractStepSummary(steps);
  const systemPrompt = `Generate a concise macro name (3-6 words, title case). Be specific about WHAT it does. Use active verbs. Mention the app if relevant. NO generic names.`;
  const userPrompt = `Name this macro:\n${summary}`;

  try {
    const name = await callHaiku(apiKey, systemPrompt, userPrompt, 30, timeout);
    let clean = name.trim().replace(/^["']|["']$/g, '').trim();
    if (clean.length > 60) clean = clean.slice(0, 57) + '...';
    console.log(`[LLM] Named: "${clean}" (${steps.length} steps)`);
    return clean;
  } catch(e) {
    console.warn(`[LLM] Naming failed (${e.message}), using pattern`);
    return patternName(steps);
  }
}

function extractStepSummary(steps) {
  const apps = new Set();
  steps.forEach(s => { if (s.axContext?.appName) apps.add(s.axContext.appName); });
  const lines = [];
  if (apps.size) lines.push(`Apps: ${[...apps].join(', ')}`);
  lines.push('Steps:');
  steps.slice(0, 10).forEach((s, i) => {
    let d = s.type;
    if (s.type === 'click' && s.axContext?.element?.title) d = `Click "${s.axContext.element.title}"`;
    else if (s.type === 'text_input' && s.text) d = `Type "${s.text.slice(0,30)}"`;
    else if ((s.type === 'key_combo' || s.type === 'keypress') && s.key) d = `Press ${(s.modifiers||[]).concat(s.key).join('+')}`;
    lines.push(`  ${i+1}. ${d}`);
  });
  if (steps.length > 10) lines.push(`  ... (${steps.length-10} more)`);
  return lines.join('\n');
}

function patternName(steps) {
  const apps = new Set();
  const actions = [];
  steps.forEach(s => {
    if (s.axContext?.appName) apps.add(s.axContext.appName);
    else if (s.axContext?.app) { const n = s.axContext.app.split('.').pop(); if (n) apps.add(n); }
  });
  for (const s of steps.slice(0, 5)) {
    if (s.type === 'click' && s.axContext?.element?.title) actions.push(s.axContext.element.title);
    else if (s.type === 'text_input' && s.text) actions.push(`"${s.text.slice(0,15)}"`);
  }
  const app = apps.size ? [...apps].slice(0,2).join('+') : 'Desktop';
  return actions.length ? `${app}: ${actions.slice(0,2).join(' > ')}` : `${app} Macro`;
}

function callHaiku(apiKey, system, user, maxTok, timeout) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31', max_tokens: maxTok,
      system, messages: [{ role: 'user', content: user }], temperature: 0.7,
    });
    const req = https.request({
      hostname: AI_GATEWAY_HOST, port: 443,
      path: '/api/v1/bedrock/model/claude-haiku-4-5-20251001/invoke',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const d = JSON.parse(body);
          if (res.statusCode >= 400) return reject(new Error(`${res.statusCode}: ${d.error?.message||body.slice(0,200)}`));
          resolve(d.content?.[0]?.text || 'Macro');
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload); req.end();
  });
}

module.exports = { generateMacroNameLLM, extractStepSummary, patternName };
