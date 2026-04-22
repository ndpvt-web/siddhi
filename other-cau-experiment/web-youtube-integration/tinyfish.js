try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch (_) {}
'use strict';

/**
 * TinyFish API Client for Atlas Desktop Agent
 * Provides: Search (web lookup), Fetch (page extraction), Agent (web automation)
 */

const TINYFISH_API_KEY = process.env.TINYFISH_API_KEY || '';

const ENDPOINTS = {
  search: 'https://api.search.tinyfish.ai',
  fetch:  'https://api.fetch.tinyfish.ai',
  agent:  'https://agent.tinyfish.ai/v1/automation',
};

function headers() {
  return {
    'X-API-Key': TINYFISH_API_KEY,
    'Content-Type': 'application/json',
  };
}

// TinyFish requires proxy_config.enabled to be a boolean — normalize it
function normalizeProxy(cfg) {
  if (!cfg) return undefined;
  return { enabled: true, ...cfg };
}

// ─── Search API ───────────────────────────────────────────────
// Returns ranked web results for a query
async function search(query, opts = {}) {
  if (!TINYFISH_API_KEY) return { ok: false, error: 'TINYFISH_API_KEY not set' };

  const params = new URLSearchParams({ query });
  if (opts.location) params.set('location', opts.location);
  if (opts.language) params.set('language', opts.language);

  try {
    const res = await fetch(`${ENDPOINTS.search}?${params}`, {
      method: 'GET',
      headers: headers(),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, body: await res.text() };
    const data = await res.json();
    return { ok: true, results: data.results || [], total: data.total_results || 0 };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Fetch API ────────────────────────────────────────────────
// Renders JS-heavy pages and extracts clean content
async function fetchPages(urls, opts = {}) {
  if (!TINYFISH_API_KEY) return { ok: false, error: 'TINYFISH_API_KEY not set' };

  const urlArray = Array.isArray(urls) ? urls : [urls];
  const body = {
    urls: urlArray.slice(0, 10),
    format: opts.format || 'markdown',
  };
  if (opts.proxy_config) body.proxy_config = normalizeProxy(opts.proxy_config);

  try {
    const res = await fetch(ENDPOINTS.fetch, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, body: await res.text() };
    const data = await res.json();
    return { ok: true, results: data.results || [], errors: data.errors || [] };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Agent API (sync) ─────────────────────────────────────────
// Runs a browser automation task and waits for result
async function runAgent(url, goal, opts = {}) {
  if (!TINYFISH_API_KEY) return { ok: false, error: 'TINYFISH_API_KEY not set' };

  const body = { url, goal };
  if (opts.proxy_config) body.proxy_config = normalizeProxy(opts.proxy_config);

  try {
    const res = await fetch(`${ENDPOINTS.agent}/run`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeout || 120000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, body: await res.text() };
    const data = await res.json();
    return { ok: true, run_id: data.run_id, status: data.status, result: data.result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Agent API (async) ────────────────────────────────────────
// Starts a browser task and returns run_id for polling
async function runAgentAsync(url, goal, opts = {}) {
  if (!TINYFISH_API_KEY) return { ok: false, error: 'TINYFISH_API_KEY not set' };

  const body = { url, goal };
  if (opts.proxy_config) body.proxy_config = normalizeProxy(opts.proxy_config);

  try {
    const res = await fetch(`${ENDPOINTS.agent}/run-async`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, body: await res.text() };
    const data = await res.json();
    return { ok: true, run_id: data.run_id, status: data.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Poll a run ───────────────────────────────────────────────
async function getRun(runId) {
  if (!TINYFISH_API_KEY) return { ok: false, error: 'TINYFISH_API_KEY not set' };

  try {
    const res = await fetch(`${ENDPOINTS.agent}/runs/${runId}`, {
      method: 'GET',
      headers: headers(),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, run_id: data.run_id, status: data.status, result: data.result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Convenience: search + fetch top result ───────────────────
async function searchAndFetch(query, opts = {}) {
  const searchResult = await search(query, opts);
  if (!searchResult.ok || searchResult.results.length === 0) {
    return { ok: false, error: searchResult.error || 'no results', searchResult };
  }

  const topUrls = searchResult.results.slice(0, opts.topN || 3).map(r => r.url);
  const fetchResult = await fetchPages(topUrls, { format: 'markdown' });

  return {
    ok: fetchResult.ok,
    search: searchResult.results,
    pages: fetchResult.results || [],
    errors: fetchResult.errors || [],
  };
}

module.exports = {
  search,
  fetchPages,
  runAgent,
  runAgentAsync,
  getRun,
  searchAndFetch,
  isConfigured: () => !!TINYFISH_API_KEY,
};
