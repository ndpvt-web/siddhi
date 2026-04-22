/**
 * Capy Macro - Variable Extraction & Parameterization
 * Phase 4: Detect dynamic content (emails, URLs, dates) in recorded macros
 * and enable parameterized replay with different values.
 */

const VARIABLE_PATTERNS = {
  email: { regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    suggestName: v => `${v.split('@')[0].replace(/[^a-zA-Z0-9]/g,'_')}_email`, prompt: 'Email address' },
  url: { regex: /https?:\/\/[^\s]+/g,
    suggestName: v => { try { return `${new URL(v).hostname.replace(/[^a-zA-Z0-9]/g,'_')}_url`; } catch(e) { return 'url'; } }, prompt: 'URL' },
  date_iso: { regex: /\b\d{4}-\d{2}-\d{2}\b/g, suggestName: () => 'date', prompt: 'Date (YYYY-MM-DD)' },
  date_slash: { regex: /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, suggestName: () => 'date', prompt: 'Date (MM/DD/YYYY)' },
  phone: { regex: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, suggestName: () => 'phone_number', prompt: 'Phone number' },
  money: { regex: /\$\d+[\d,.]*\b/g, suggestName: () => 'amount', prompt: 'Amount' },
  home_path: { regex: /~\/[^\s]+/g, suggestName: v => `${v.split('/').pop().replace(/[^a-zA-Z0-9]/g,'_')}_path`, prompt: 'File path' },
  absolute_path: { regex: /\/(?:Users|home|var|tmp|opt|etc)[^\s]+/g, suggestName: v => `${v.split('/').pop().replace(/[^a-zA-Z0-9]/g,'_')}_path`, prompt: 'File path' },
};
const PATTERN_ORDER = ['email','url','date_iso','date_slash','phone','money','home_path','absolute_path'];

/**
 * Extract variable candidates from macro steps.
 * Scans text_input steps for emails, URLs, dates, etc.
 */
function extractVariables(steps) {
  const vars = [];
  const seen = new Map();
  steps.forEach((step, idx) => {
    if (step.type !== 'text_input' || !step.text) return;
    const matches = [];
    for (const pn of PATTERN_ORDER) {
      const p = VARIABLE_PATTERNS[pn];
      const re = new RegExp(p.regex.source, p.regex.flags);
      let m;
      while ((m = re.exec(step.text)) !== null) {
        matches.push({ type: pn, value: m[0], start: m.index, end: m.index + m[0].length });
      }
    }
    matches.sort((a, b) => a.start - b.start);
    // Remove overlaps
    const clean = [];
    let lastEnd = -1;
    for (const m of matches) { if (m.start >= lastEnd) { clean.push(m); lastEnd = m.end; } }

    clean.forEach(m => {
      const p = VARIABLE_PATTERNS[m.type];
      let name = p.suggestName(m.value);
      if (seen.has(m.value)) { name = seen.get(m.value); }
      else {
        let base = name, ct = 1;
        while ([...seen.values()].includes(name)) { name = `${base}_${ct++}`; }
        seen.set(m.value, name);
      }
      vars.push({ stepId: step.id, stepIndex: idx, type: m.type, value: m.value,
        suggestedName: name, placeholder: `{{${name}}}`, prompt: p.prompt, start: m.start, end: m.end });
    });
  });
  return vars;
}

/**
 * Suggest variables for a manifest (post-recording).
 */
function suggestVariables(manifest) {
  if (!manifest?.steps?.length) return {};
  const detected = extractVariables(manifest.steps);
  const grouped = {};
  detected.forEach(v => { if (!grouped[v.suggestedName]) grouped[v.suggestedName] = []; grouped[v.suggestedName].push(v); });
  const suggestions = {};
  Object.entries(grouped).forEach(([name, occs]) => {
    const f = occs[0];
    suggestions[name] = { type: f.type, default: f.value, prompt: f.prompt, occurrences: occs.length, stepIds: occs.map(v=>v.stepId) };
  });
  return suggestions;
}

/**
 * Replace {{variable}} placeholders with values.
 */
function resolveVariables(text, varMap) {
  if (!text) return text;
  return text.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, name) => {
    return varMap?.hasOwnProperty(name) ? varMap[name] : match;
  });
}

/**
 * Replace detected values with {{placeholders}} in steps.
 */
function parameterizeSteps(steps, varsToReplace) {
  const cloned = JSON.parse(JSON.stringify(steps));
  const byStep = {};
  varsToReplace.forEach(v => { if (!byStep[v.stepIndex]) byStep[v.stepIndex] = []; byStep[v.stepIndex].push(v); });
  Object.entries(byStep).forEach(([idx, vars]) => {
    const s = cloned[parseInt(idx)];
    if (s?.type === 'text_input' && s.text) {
      let t = s.text;
      [...vars].sort((a,b) => b.start - a.start).forEach(v => {
        t = t.substring(0, v.start) + v.placeholder + t.substring(v.end);
      });
      s.text = t;
    }
  });
  return cloned;
}

/**
 * Full parameterization workflow for a recorded macro.
 */
function parameterizeMacro(manifest, selectedVars = null) {
  const suggestions = suggestVariables(manifest);
  const toUse = selectedVars || Object.keys(suggestions);
  const all = extractVariables(manifest.steps);
  const toReplace = all.filter(v => toUse.includes(v.suggestedName));
  const paramSteps = parameterizeSteps(manifest.steps, toReplace);
  const varDefs = {};
  toUse.forEach(n => { if (suggestions[n]) varDefs[n] = { type: suggestions[n].type, default: suggestions[n].default, prompt: suggestions[n].prompt }; });
  return { ...manifest, steps: paramSteps, variables: varDefs };
}

/**
 * Prepare macro for replay with variable substitution.
 */
function prepareForReplay(manifest, userVars = {}) {
  const merged = {};
  Object.entries(manifest.variables || {}).forEach(([n, s]) => { merged[n] = s.default || ''; });
  Object.entries(userVars).forEach(([n, v]) => { merged[n] = v; });
  const cloned = JSON.parse(JSON.stringify(manifest.steps));
  cloned.forEach(s => { if (s.type === 'text_input' && s.text) s.text = resolveVariables(s.text, merged); });
  return cloned;
}

module.exports = {
  extractVariables, suggestVariables, resolveVariables, parameterizeSteps,
  parameterizeMacro, prepareForReplay, VARIABLE_PATTERNS, PATTERN_ORDER,
};
