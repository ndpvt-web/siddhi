/**
 * Capy Macro - FTS5 Search Index + Context-Aware Ranking
 * Phase 3: Full-text search via macOS built-in sqlite3 CLI
 * Phase 4: Context-aware ranking (app, recency, frequency)
 *
 * Zero npm dependencies - uses sqlite3 CLI that ships with macOS.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MACROS_DIR = '/tmp/capy-macros';
const DB_PATH = '/tmp/capy-macros/search-index.db';
const RECENT_FILE = '/tmp/capy-macros/recent-executions.json';

let sqliteAvailable = null;
let recentExecutions = [];

// ---------------------------------------------------------------------------
// SQLite Helpers
// ---------------------------------------------------------------------------

function checkSqlite() {
  if (sqliteAvailable !== null) return sqliteAvailable;
  try {
    execSync('which sqlite3', { timeout: 3000, stdio: 'pipe' });
    sqliteAvailable = true;
  } catch (e) {
    sqliteAvailable = false;
    console.warn('[FTS5] sqlite3 not available, using in-memory fallback');
  }
  return sqliteAvailable;
}

function sqlExec(sql) {
  if (!checkSqlite()) return null;
  const tmpSql = `/tmp/capy-fts5-${Date.now()}-${Math.random().toString(36).slice(2,6)}.sql`;
  try {
    fs.writeFileSync(tmpSql, sql);
    const output = execSync(`sqlite3 "${DB_PATH}" < "${tmpSql}"`, {
      timeout: 5000, stdio: 'pipe', encoding: 'utf-8',
    });
    try { fs.unlinkSync(tmpSql); } catch(e){}
    return output;
  } catch (e) {
    console.warn(`[FTS5] SQL error: ${e.message.slice(0, 200)}`);
    try { fs.unlinkSync(tmpSql); } catch(e){}
    return null;
  }
}

function sanitize(str) {
  if (!str) return '';
  return String(str).replace(/'/g, "''");
}

// ---------------------------------------------------------------------------
// FTS5 Index Operations
// ---------------------------------------------------------------------------

function initSearchIndex() {
  if (!checkSqlite()) return false;
  if (!fs.existsSync(MACROS_DIR)) fs.mkdirSync(MACROS_DIR, { recursive: true });
  const r = sqlExec(`CREATE VIRTUAL TABLE IF NOT EXISTS macro_index USING fts5(
  macro_id UNINDEXED, name, description, tags, app_names,
  step_count UNINDEXED, last_used UNINDEXED, use_count UNINDEXED, created_at UNINDEXED
);`);
  if (r !== null) { console.log('[FTS5] Search index initialized'); return true; }
  return false;
}

function indexMacro(manifest) {
  if (!checkSqlite() || !manifest?.id) return false;
  const id = sanitize(manifest.id);
  const name = sanitize(manifest.name || '');
  const desc = sanitize(manifest.description || '');
  const tags = sanitize((manifest.tags || []).join(' '));
  const apps = new Set();
  (manifest.steps || []).forEach(s => {
    if (s.axContext?.appName) apps.add(s.axContext.appName);
    if (s.axContext?.app) { const sn = s.axContext.app.split('.').pop(); if(sn) apps.add(sn); }
  });
  if (manifest.appContext) apps.add(manifest.appContext);
  const appStr = sanitize(Array.from(apps).join(' '));
  const sc = manifest.stepCount || (manifest.steps||[]).length;
  const lu = manifest.lastUsed || 0;
  const uc = manifest.useCount || 0;
  const ca = sanitize(manifest.createdAt || '');
  return sqlExec(`DELETE FROM macro_index WHERE macro_id = '${id}';
INSERT INTO macro_index VALUES('${id}','${name}','${desc}','${tags}','${appStr}',${sc},${lu},${uc},'${ca}');`) !== null;
}

function removeFromIndex(macroId) {
  if (!checkSqlite() || !macroId) return false;
  return sqlExec(`DELETE FROM macro_index WHERE macro_id = '${sanitize(macroId)}';`) !== null;
}

function rebuildIndex() {
  if (!checkSqlite()) return false;
  sqlExec('DELETE FROM macro_index;');
  try {
    if (!fs.existsSync(MACROS_DIR)) return true;
    const dirs = fs.readdirSync(MACROS_DIR).filter(d => fs.existsSync(path.join(MACROS_DIR, d, 'manifest.json')));
    let ct = 0;
    for (const d of dirs) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(MACROS_DIR, d, 'manifest.json'), 'utf-8'));
        if (indexMacro(m)) ct++;
      } catch(e){}
    }
    console.log(`[FTS5] Rebuilt: ${ct} macros indexed`);
    return true;
  } catch(e) { return false; }
}

function searchFTS5(query, limit = 10) {
  if (!checkSqlite() || !query) return [];
  const safe = sanitize(query.trim());
  if (!safe) return [];
  const terms = safe.split(/\s+/).filter(t => t.length >= 2);
  const ftsQ = terms.length > 1 ? `"${safe}" OR ${terms.join(' OR ')}` : safe;
  const out = sqlExec(`.mode json
SELECT macro_id,name,description,tags,app_names,step_count,last_used,use_count,rank
FROM macro_index WHERE macro_index MATCH '${sanitize(ftsQ)}' ORDER BY rank LIMIT ${limit};`);
  if (!out?.trim()) return [];
  try {
    return JSON.parse(out).map(r => ({
      id: r.macro_id, name: r.name, description: r.description,
      tags: (r.tags||'').split(' ').filter(Boolean), appContext: r.app_names,
      stepCount: r.step_count, lastUsed: r.last_used, useCount: r.use_count, _ftsRank: r.rank,
    }));
  } catch(e) { return []; }
}

// ---------------------------------------------------------------------------
// Recent Execution Tracking
// ---------------------------------------------------------------------------

function loadRecentExecutions() {
  try {
    if (fs.existsSync(RECENT_FILE)) recentExecutions = JSON.parse(fs.readFileSync(RECENT_FILE, 'utf-8'));
  } catch(e) { recentExecutions = []; }
}

function recordExecution(macroId, macroName) {
  recentExecutions.unshift({ macroId, name: macroName, timestamp: Date.now() });
  if (recentExecutions.length > 50) recentExecutions = recentExecutions.slice(0, 50);
  try { fs.writeFileSync(RECENT_FILE, JSON.stringify(recentExecutions)); } catch(e){}
}

function getRecentMacros(n = 5) { return recentExecutions.slice(0, n); }
function getLastExecutedMacroId() { return recentExecutions[0]?.macroId || null; }

// ---------------------------------------------------------------------------
// Context-Aware Ranking
// ---------------------------------------------------------------------------

function rankByContext(results, context = {}, query = '') {
  const now = Date.now();
  const qLower = (query || '').toLowerCase();
  return results.map(r => {
    let score = 0;
    // Current app matches: +2.0
    if (context.currentApp && r.appContext) {
      const a = r.appContext.toLowerCase(), c = context.currentApp.toLowerCase();
      if (a.includes(c) || c.includes(a)) score += 2.0;
    }
    // Recency: 30-day exponential decay: +0-1.0
    if (r.lastUsed) {
      const days = (now - r.lastUsed) / 86400000;
      if (days <= 30) score += Math.exp(-days / 10);
    }
    // Frequency: log scale: +0-2.0
    if (r.useCount > 0) score += Math.min(2.0, Math.log2(r.useCount + 1) * 0.5);
    // Exact name match: +3.0
    if (qLower && r.name) {
      const n = r.name.toLowerCase();
      if (n === qLower) score += 3.0;
      else if (n.includes(qLower) || qLower.includes(n)) score += 1.5;
    }
    return { ...r, _contextScore: score };
  }).sort((a, b) => b._contextScore - a._contextScore);
}

function searchMacrosEnhanced(query, context = {}, fuzzyFallback = null) {
  let results = searchFTS5(query);
  if (results.length === 0 && fuzzyFallback) results = fuzzyFallback(query);
  if (results.length > 0) results = rankByContext(results, context, query);
  return results;
}

loadRecentExecutions();

module.exports = {
  initSearchIndex, indexMacro, removeFromIndex, rebuildIndex, searchFTS5,
  rankByContext, searchMacrosEnhanced, recordExecution, getRecentMacros,
  getLastExecutedMacroId, loadRecentExecutions,
};
