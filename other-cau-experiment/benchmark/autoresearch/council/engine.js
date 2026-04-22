#!/usr/bin/env node
/**
 * Atlas Optimization Council Engine
 *
 * 3-model committee for hypothesis generation, debate, and evaluation.
 * Uses AI Gateway (OpenRouter-compatible) to query diverse models.
 *
 * Usage:
 *   node engine.js analyze <phase1-results> <phase2-results>
 *   node engine.js hypothesize <analysis-file>
 *   node engine.js debate <proposals-file> <analysis-file>
 *   node engine.js evaluate <before-file> <after-file> <hypothesis-file>
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// --- Config ---
const API_URL = 'https://ai-gateway.happycapy.ai/api/v1/chat/completions';
const API_KEY = process.env.AI_GATEWAY_API_KEY;

const MODELS = {
  strategist: 'openai/gpt-4.1',
  challenger: 'openai/gpt-4o',
  pragmatist: 'x-ai/grok-3'
};

const ATLAS_ROOT = '/Users/nivesh/Projects/atlas-copy';
const RESULTS_DIR = path.join(ATLAS_ROOT, 'benchmark/benchmark-results');
const COUNCIL_DIR = path.join(ATLAS_ROOT, 'benchmark/autoresearch/council');

// --- AI Gateway Client ---
function callModel(model, messages, temperature = 0.7) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ model, messages, temperature, max_tokens: 4096 });
    const url = new URL(API_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          else resolve(parsed.choices[0].message.content);
        } catch (e) { reject(new Error(`Parse error: ${e.message}\nRaw: ${data.slice(0, 500)}`)); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// --- Phase 1: Analyze Benchmark Results ---
async function analyze() {
  const phase1Path = path.join(RESULTS_DIR, 'phase1-results.json');
  const phase2Path = path.join(RESULTS_DIR, 'phase2-results.json');
  const comparisonPath = path.join(RESULTS_DIR, 'comparison-database.json');

  const phase1 = JSON.parse(fs.readFileSync(phase1Path, 'utf8'));
  const phase2 = fs.existsSync(phase2Path) ? JSON.parse(fs.readFileSync(phase2Path, 'utf8')) : null;
  const comparison = fs.existsSync(comparisonPath) ? JSON.parse(fs.readFileSync(comparisonPath, 'utf8')) : null;

  // Build failure analysis
  const failures = phase1.results.filter(r => !r.success);
  const successes = phase1.results.filter(r => r.success);

  // Categorize failures by app
  const failuresByApp = {};
  failures.forEach(f => {
    const app = f.app || f.category || 'unknown';
    if (!failuresByApp[app]) failuresByApp[app] = [];
    failuresByApp[app].push({
      id: f.taskId || f.id,
      task: f.task,
      error: (f.error || f.result || '').toString().slice(0, 300),
      iterations: f.iterations || f.steps || 0
    });
  });

  // Categorize failures by error pattern
  const errorPatterns = {};
  failures.forEach(f => {
    const err = (f.error || f.result || '').toString();
    let pattern = 'unknown';
    if (err.includes('timeout') || err.includes('Timeout')) pattern = 'timeout';
    else if (err.includes('not found') || err.includes('NotFound')) pattern = 'element_not_found';
    else if (err.includes('click') || err.includes('coordinate')) pattern = 'click_targeting';
    else if (err.includes('iteration') || err.includes('max')) pattern = 'max_iterations';
    else if (err.includes('screenshot')) pattern = 'screenshot_issue';
    else if (err.length > 0) pattern = 'other_error';

    if (!errorPatterns[pattern]) errorPatterns[pattern] = [];
    errorPatterns[pattern].push(f.taskId || f.id);
  });

  // Phase 2 improvements
  let phase2Analysis = null;
  if (comparison) {
    phase2Analysis = {
      fixed: (comparison.results || []).filter(r => r.comparison === 'FIXED').map(r => ({ id: r.taskId, task: r.task })),
      regressed: (comparison.results || []).filter(r => r.comparison === 'REGRESSED').map(r => ({ id: r.taskId, task: r.task })),
      same: (comparison.results || []).filter(r => r.comparison === 'SAME').length
    };
  }

  // Read key source files for context
  const keyFiles = ['modules/computer-use.js', 'modules/ax-grounding.js', 'modules/trajectory.js', 'modules/brain-macos-bridge.js'];
  const sourceContext = {};
  for (const f of keyFiles) {
    const fp = path.join(ATLAS_ROOT, f);
    if (fs.existsSync(fp)) {
      const content = fs.readFileSync(fp, 'utf8');
      sourceContext[f] = content.slice(0, 3000); // First 3K chars for context
    }
  }

  const analysis = {
    timestamp: new Date().toISOString(),
    summary: {
      totalTasks: phase1.results.length,
      successes: successes.length,
      failures: failures.length,
      successRate: `${((successes.length / phase1.results.length) * 100).toFixed(1)}%`
    },
    failuresByApp,
    errorPatterns,
    phase2Analysis,
    sourceFileSnippets: sourceContext,
    // Include worst-performing apps
    worstApps: Object.entries(failuresByApp)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 5)
      .map(([app, fails]) => ({ app, failCount: fails.length }))
  };

  const outPath = path.join(COUNCIL_DIR, 'analysis.json');
  fs.mkdirSync(COUNCIL_DIR, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(analysis, null, 2));
  console.log(`Analysis written to ${outPath}`);
  console.log(`Summary: ${analysis.summary.successRate} success rate (${analysis.summary.successes}/${analysis.summary.totalTasks})`);
  console.log(`Worst apps: ${analysis.worstApps.map(a => `${a.app}(${a.failCount})`).join(', ')}`);
  return analysis;
}

// --- Phase 2: Hypothesize (3 models independently propose) ---
async function hypothesize() {
  const analysisPath = path.join(COUNCIL_DIR, 'analysis.json');
  const analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf8'));

  // Load iteration history for context
  const statePath = path.join(ATLAS_ROOT, 'benchmark/autoresearch/loop-state.json');
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { history: [] };

  const historyContext = state.history.length > 0
    ? `\n\nPREVIOUS ITERATIONS (do NOT repeat failed strategies):\n${state.history.map(h =>
        `- Iteration ${h.iteration}: "${h.hypothesis}" -> ${h.result} (${h.successRate})`
      ).join('\n')}`
    : '';

  const systemPrompt = `You are an expert computer-use AI system architect analyzing benchmark failures for a macOS automation agent called Atlas.

Atlas uses Claude's computer-use API to control a Mac desktop -- taking screenshots, clicking, typing, etc.
It has modules for: screenshot capture, AX (accessibility) grounding, trajectory planning, and a brain (LLM reasoning).

Your job: Propose ONE specific, implementable code change that would fix the highest number of failing tasks.

RULES:
- Exactly ONE change. Not two. Not a refactor. One surgical modification.
- Must be implementable as a code diff (you will specify the exact file and change)
- Must have a testable prediction: "This will fix tasks X, Y, Z because..."
- Must be specific: not "improve error handling" but "add 2-second retry with exponential backoff in computer-use.js line 145 when screenshot returns black"
- Consider the error patterns and which apps fail most${historyContext}`;

  const userPrompt = `Here is the benchmark analysis:

SUCCESS RATE: ${analysis.summary.successRate} (${analysis.summary.successes}/${analysis.summary.totalTasks})

FAILURES BY APP:
${JSON.stringify(analysis.failuresByApp, null, 2)}

ERROR PATTERNS:
${JSON.stringify(analysis.errorPatterns, null, 2)}

${analysis.phase2Analysis ? `PHASE 2 COMPARISON:
Fixed on retry: ${analysis.phase2Analysis.fixed.length} tasks
Regressed on retry: ${analysis.phase2Analysis.regressed.length} tasks
Same result: ${analysis.phase2Analysis.same} tasks` : ''}

KEY SOURCE FILE SNIPPETS:
${Object.entries(analysis.sourceFileSnippets || {}).map(([f, c]) => `--- ${f} ---\n${c}\n`).join('\n')}

Respond in this exact JSON format:
{
  "hypothesis": "One-sentence description of the change",
  "rationale": "Why this will work (2-3 sentences)",
  "targetFile": "path/to/file.js",
  "change": {
    "type": "insert|replace|append",
    "location": "description of where (function name, line context)",
    "oldCode": "exact code to replace (if type=replace)",
    "newCode": "exact new code"
  },
  "expectedImpact": {
    "tasksThatShouldFix": ["task-id-1", "task-id-2"],
    "estimatedNewSuccessRate": "X%",
    "risk": "low|medium|high"
  }
}`;

  console.log('Querying 3 models for hypotheses...');

  const proposals = {};
  const results = await Promise.allSettled([
    callModel(MODELS.strategist, [
      { role: 'system', content: systemPrompt + '\n\nYou are the STRATEGIST. Focus on structural/architectural improvements that address root causes.' },
      { role: 'user', content: userPrompt }
    ]),
    callModel(MODELS.challenger, [
      { role: 'system', content: systemPrompt + '\n\nYou are the CHALLENGER. Look for the non-obvious fix. What is everyone else missing? Focus on edge cases and failure modes.' },
      { role: 'user', content: userPrompt }
    ]),
    callModel(MODELS.pragmatist, [
      { role: 'system', content: systemPrompt + '\n\nYou are the PRAGMATIST. What is the simplest change with the highest expected value? Favor low-risk, high-reward changes.' },
      { role: 'user', content: userPrompt }
    ])
  ]);

  const roles = ['strategist', 'challenger', 'pragmatist'];
  for (let i = 0; i < results.length; i++) {
    const role = roles[i];
    if (results[i].status === 'fulfilled') {
      const raw = results[i].value;
      try {
        // Extract JSON from response (may be wrapped in markdown)
        let cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '');
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        let parsed = null;
        if (jsonMatch) {
          // Try 1: parse as-is
          try { parsed = JSON.parse(jsonMatch[0]); } catch(e1) {
            // Try 2: sanitize control chars inside string values only
            try {
              const sanitized = jsonMatch[0].replace(/"(?:[^"\\]|\\.)*"/g, (str) =>
                str.replace(/[\x00-\x1f]/g, (ch) => ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : '')
              );
              parsed = JSON.parse(sanitized);
            } catch(e2) {
              // Try 3: strip JS comments outside strings, then sanitize
              try {
                let stripped = jsonMatch[0].replace(/"(?:[^"\\]|\\.)*"/g, (m) => '\x00STR' + Buffer.from(m).toString('base64') + '\x00');
                stripped = stripped.replace(/\/\/[^\n]*/g, '').replace(/,\s*([\]}])/g, '$1');
                stripped = stripped.replace(/\x00STR([A-Za-z0-9+/=]+)\x00/g, (_, b64) => Buffer.from(b64, 'base64').toString());
                stripped = stripped.replace(/"(?:[^"\\]|\\.)*"/g, (str) =>
                  str.replace(/[\x00-\x1f]/g, (ch) => ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : '')
                );
                parsed = JSON.parse(stripped);
              } catch(e3) { /* give up */ }
            }
          }
        }
        proposals[role] = {
          model: MODELS[role],
          raw: raw,
          parsed
        };
        console.log(`  ${role} (${MODELS[role]}): ${proposals[role].parsed?.hypothesis || 'PARSE_FAILED'}`);
      } catch (e) {
        proposals[role] = { model: MODELS[role], raw: raw, parsed: null, error: e.message };
        console.log(`  ${role}: JSON parse failed - ${e.message}`);
      }
    } else {
      proposals[role] = { model: MODELS[role], error: results[i].reason.message };
      console.log(`  ${role}: API call failed - ${results[i].reason.message}`);
    }
  }

  const outPath = path.join(COUNCIL_DIR, 'proposals.json');
  fs.writeFileSync(outPath, JSON.stringify(proposals, null, 2));
  console.log(`\nProposals written to ${outPath}`);
  return proposals;
}

// --- Phase 3: Debate and Select ---
async function debate() {
  const proposalsPath = path.join(COUNCIL_DIR, 'proposals.json');
  const analysisPath = path.join(COUNCIL_DIR, 'analysis.json');
  const proposals = JSON.parse(fs.readFileSync(proposalsPath, 'utf8'));
  const analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf8'));

  // Format proposals for debate
  const proposalSummaries = Object.entries(proposals)
    .filter(([_, p]) => p.parsed)
    .map(([role, p]) => `### ${role.toUpperCase()} (${p.model})\n${JSON.stringify(p.parsed, null, 2)}`)
    .join('\n\n');

  if (proposalSummaries.length === 0) {
    console.error('No valid proposals to debate!');
    process.exit(1);
  }

  const debatePrompt = `You are judging a debate between 3 AI optimization experts. Each proposed ONE code change to improve a macOS automation agent (Atlas) benchmark score.

Current success rate: ${analysis.summary.successRate}

THE PROPOSALS:
${proposalSummaries}

EVALUATION CRITERIA:
1. **Specificity**: Is the change precisely defined and implementable?
2. **Impact**: How many failing tasks could this realistically fix?
3. **Risk**: Could this break currently-passing tasks?
4. **Testability**: Can we verify if this worked within 15 benchmark tasks?
5. **Novelty**: Does this address a root cause or just a symptom?

RESPOND WITH:
{
  "winner": "strategist|challenger|pragmatist",
  "reasoning": "2-3 sentences explaining why this proposal wins",
  "concerns": "Any risks or caveats to watch for",
  "testTasks": ["list of 10-15 task IDs to test this hypothesis against"],
  "votes": {
    "strategist_score": 1-10,
    "challenger_score": 1-10,
    "pragmatist_score": 1-10
  }
}`;

  console.log('Running debate across 3 judges...');

  const judgeResults = await Promise.allSettled([
    callModel(MODELS.strategist, [{ role: 'user', content: debatePrompt }], 0.3),
    callModel(MODELS.challenger, [{ role: 'user', content: debatePrompt }], 0.3),
    callModel(MODELS.pragmatist, [{ role: 'user', content: debatePrompt }], 0.3)
  ]);

  // Tally votes
  const votes = { strategist: 0, challenger: 0, pragmatist: 0 };
  const judgments = [];

  const roles = ['strategist', 'challenger', 'pragmatist'];
  for (let i = 0; i < judgeResults.length; i++) {
    if (judgeResults[i].status === 'fulfilled') {
      try {
        const raw = judgeResults[i].value;
        let cleanedRaw = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '');
        const jsonMatch = cleanedRaw.match(/\{[\s\S]*\}/);
        let parsed = null;
        if (jsonMatch) {
          try { parsed = JSON.parse(jsonMatch[0]); } catch(e1) {
            try {
              const sanitized = jsonMatch[0].replace(/"(?:[^"\\]|\\.)*"/g, (str) =>
                str.replace(/[\x00-\x1f]/g, (ch) => ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : '')
              );
              parsed = JSON.parse(sanitized);
            } catch(e2) { /* give up */ }
          }
        }
        if (parsed && parsed.winner) {
          votes[parsed.winner] += 1;
          judgments.push({ judge: roles[i], ...parsed });
          console.log(`  Judge ${roles[i]}: votes for ${parsed.winner} (scores: S=${parsed.votes?.strategist_score} C=${parsed.votes?.challenger_score} P=${parsed.votes?.pragmatist_score})`);
        }
      } catch (e) {
        console.log(`  Judge ${roles[i]}: parse error - ${e.message}`);
      }
    }
  }

  // Determine winner
  const winner = Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0];
  const winnerProposal = proposals[winner]?.parsed;

  // Collect test tasks from judgments
  const allTestTasks = [...new Set(judgments.flatMap(j => j.testTasks || []))].slice(0, 15);

  const decision = {
    timestamp: new Date().toISOString(),
    winner,
    winnerProposal,
    votes,
    judgments,
    testTasks: allTestTasks
  };

  const outPath = path.join(COUNCIL_DIR, 'decision.json');
  fs.writeFileSync(outPath, JSON.stringify(decision, null, 2));
  console.log(`\nWINNER: ${winner} with ${votes[winner]} votes`);
  console.log(`Hypothesis: ${winnerProposal?.hypothesis}`);
  console.log(`Test tasks: ${allTestTasks.length} selected`);
  console.log(`Decision written to ${outPath}`);
  return decision;
}

// --- Phase 5: Evaluate Results ---
async function evaluate() {
  const decisionPath = path.join(COUNCIL_DIR, 'decision.json');
  const beforePath = path.join(COUNCIL_DIR, 'test-before.json');
  const afterPath = path.join(COUNCIL_DIR, 'test-after.json');

  const decision = JSON.parse(fs.readFileSync(decisionPath, 'utf8'));
  const before = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
  const after = JSON.parse(fs.readFileSync(afterPath, 'utf8'));

  const beforeSuccess = before.results?.filter(r => r.success).length || 0;
  const afterSuccess = after.results?.filter(r => r.success).length || 0;
  const totalTested = after.results?.length || 0;

  // Per-task comparison
  const taskComparison = [];
  for (const afterTask of (after.results || [])) {
    const beforeTask = (before.results || []).find(b => (b.taskId || b.id) === (afterTask.taskId || afterTask.id));
    taskComparison.push({
      taskId: afterTask.taskId || afterTask.id,
      before: beforeTask?.success || false,
      after: afterTask.success || false,
      change: !beforeTask?.success && afterTask.success ? 'FIXED' :
              beforeTask?.success && !afterTask.success ? 'REGRESSED' : 'SAME'
    });
  }

  const fixed = taskComparison.filter(t => t.change === 'FIXED');
  const regressed = taskComparison.filter(t => t.change === 'REGRESSED');

  const evalPrompt = `You are evaluating whether a code change improved a macOS automation agent (Atlas).

HYPOTHESIS: ${decision.winnerProposal?.hypothesis}
RATIONALE: ${decision.winnerProposal?.rationale}

RESULTS:
- Before: ${beforeSuccess}/${totalTested} tasks passed
- After: ${afterSuccess}/${totalTested} tasks passed
- Fixed (was failing, now passing): ${fixed.length} tasks: ${fixed.map(f => f.taskId).join(', ')}
- Regressed (was passing, now failing): ${regressed.length} tasks: ${regressed.map(r => r.taskId).join(', ')}
- Net improvement: ${fixed.length - regressed.length} tasks

PER-TASK DETAILS:
${JSON.stringify(taskComparison, null, 2)}

VOTE: Should we KEEP this change or REVERT it?

Respond with:
{
  "vote": "KEEP|REVERT",
  "confidence": 1-10,
  "reasoning": "Why you voted this way (2-3 sentences)",
  "concerns": "Any concerns even if voting KEEP"
}`;

  console.log('Running evaluation council...');

  const evalResults = await Promise.allSettled([
    callModel(MODELS.strategist, [{ role: 'user', content: evalPrompt }], 0.2),
    callModel(MODELS.challenger, [{ role: 'user', content: evalPrompt }], 0.2),
    callModel(MODELS.pragmatist, [{ role: 'user', content: evalPrompt }], 0.2)
  ]);

  let keepVotes = 0, revertVotes = 0;
  const evaluations = [];
  const roles = ['strategist', 'challenger', 'pragmatist'];

  for (let i = 0; i < evalResults.length; i++) {
    if (evalResults[i].status === 'fulfilled') {
      try {
        const raw = evalResults[i].value;
        let cleanedRaw = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '');
        const jsonMatch = cleanedRaw.match(/\{[\s\S]*\}/);
        let parsed = null;
        if (jsonMatch) {
          try { parsed = JSON.parse(jsonMatch[0]); } catch(e1) {
            try {
              const sanitized = jsonMatch[0].replace(/"(?:[^"\\]|\\.)*"/g, (str) =>
                str.replace(/[\x00-\x1f]/g, (ch) => ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : '')
              );
              parsed = JSON.parse(sanitized);
            } catch(e2) { /* give up */ }
          }
        }
        if (parsed) {
          if (parsed.vote === 'KEEP') keepVotes++;
          else revertVotes++;
          evaluations.push({ judge: roles[i], ...parsed });
          console.log(`  ${roles[i]}: ${parsed.vote} (confidence: ${parsed.confidence}/10)`);
        }
      } catch (e) {
        console.log(`  ${roles[i]}: parse error`);
      }
    }
  }

  const verdict = keepVotes > revertVotes ? 'KEEP' : 'REVERT';

  const evaluation = {
    timestamp: new Date().toISOString(),
    verdict,
    keepVotes,
    revertVotes,
    evaluations,
    metrics: {
      beforeSuccess,
      afterSuccess,
      totalTested,
      fixed: fixed.length,
      regressed: regressed.length,
      net: fixed.length - regressed.length
    },
    taskComparison
  };

  const outPath = path.join(COUNCIL_DIR, 'evaluation.json');
  fs.writeFileSync(outPath, JSON.stringify(evaluation, null, 2));
  console.log(`\nVERDICT: ${verdict} (${keepVotes} keep, ${revertVotes} revert)`);
  console.log(`Net change: ${fixed.length} fixed, ${regressed.length} regressed`);
  return evaluation;
}

// --- CLI ---
const command = process.argv[2];
(async () => {
  try {
    switch (command) {
      case 'analyze': await analyze(); break;
      case 'hypothesize': await hypothesize(); break;
      case 'debate': await debate(); break;
      case 'evaluate': await evaluate(); break;
      default:
        console.log('Usage: node engine.js <analyze|hypothesize|debate|evaluate>');
        process.exit(1);
    }
  } catch (e) {
    console.error(`Error in ${command}:`, e.message);
    process.exit(1);
  }
})();
