#!/usr/bin/env node
/**
 * atlas-benchmark-phase2.js
 *
 * Phase 2: Retry the 30 most complex/failed tasks from Phase 1.
 * Builds a comparison database showing improvement.
 *
 * Usage: node atlas-benchmark-phase2.js
 */

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ATLAS_HOST = 'localhost';
const ATLAS_PORT = 7890;
const ATLAS_TOKEN = 'capy_65cf825ac1bd223b561d7d080f03914c7b01546eb51f98f74fdc61a7079480d3';
const RESULTS_DIR = path.join(__dirname, 'benchmark-results');
const PHASE1_FILE = path.join(RESULTS_DIR, 'phase1-results.json');
const PHASE2_FILE = path.join(RESULTS_DIR, 'phase2-results.json');
const COMPARISON_FILE = path.join(RESULTS_DIR, 'comparison-database.json');
const TASK_TIMEOUT_MS = 5 * 60 * 1000;

function atlasRequest(endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: ATLAS_HOST, port: ATLAS_PORT, path: endpoint, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ATLAS_TOKEN}`, 'Content-Length': Buffer.byteLength(data) },
      timeout: TASK_TIMEOUT_MS,
    }, (res) => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, data: { raw } }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runTask(task, attempt = 1) {
  const startTime = Date.now();
  console.log(`\n[Task ${task.taskId}] ${task.app} (${task.complexity}) - Attempt ${attempt}`);
  console.log(`  ${task.instruction}`);

  try {
    const response = await atlasRequest('/computer/agent', {
      task: task.instruction,
      maxIterations: 15,
    });
    const elapsed = Date.now() - startTime;
    const success = response.status === 200 && response.data?.success === true;
    console.log(`  ${success ? 'SUCCESS' : 'FAILED'} in ${(elapsed/1000).toFixed(1)}s | ${response.data?.iterations || 0} iterations`);
    return {
      taskId: task.taskId, app: task.app, complexity: task.complexity,
      instruction: task.instruction, phase: 2, attempt,
      startTime: new Date(startTime).toISOString(), elapsedMs: elapsed,
      httpStatus: response.status, success,
      iterations: response.data?.iterations || 0,
      checkpoints: response.data?.checkpoints?.length || 0,
      steps: response.data?.steps || [],
      trajectoryId: response.data?.trajectoryId || null,
      finalText: response.data?.finalText || null,
      error: response.data?.error || null,
    };
  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.log(`  ERROR: ${err.message}`);
    if (attempt < 2) { await sleep(10000); return runTask(task, attempt + 1); }
    return {
      taskId: task.taskId, app: task.app, complexity: task.complexity,
      instruction: task.instruction, phase: 2, attempt,
      startTime: new Date(startTime).toISOString(), elapsedMs: elapsed,
      httpStatus: 0, success: false, iterations: 0, checkpoints: 0,
      steps: [], trajectoryId: null, finalText: null, error: err.message,
    };
  }
}

async function main() {
  // Load Phase 1 results
  if (!fs.existsSync(PHASE1_FILE)) {
    console.error('Phase 1 results not found. Run phase 1 first.');
    process.exit(1);
  }
  const phase1 = JSON.parse(fs.readFileSync(PHASE1_FILE, 'utf8'));

  // Select 30 hardest tasks:
  // 1. All failed tasks
  // 2. Slowest successful tasks (most iterations)
  // 3. All "hard" complexity tasks
  const failed = phase1.results.filter(r => !r.success);
  const hard = phase1.results.filter(r => r.complexity === 'hard' && r.success);
  const slowest = phase1.results
    .filter(r => r.success && r.complexity !== 'hard')
    .sort((a, b) => b.iterations - a.iterations || b.elapsedMs - a.elapsedMs);

  const selectedIds = new Set();
  const selected = [];

  // Add all failed first
  for (const r of failed) {
    if (selected.length >= 30) break;
    if (!selectedIds.has(r.taskId)) { selectedIds.add(r.taskId); selected.push(r); }
  }
  // Then hard tasks
  for (const r of hard) {
    if (selected.length >= 30) break;
    if (!selectedIds.has(r.taskId)) { selectedIds.add(r.taskId); selected.push(r); }
  }
  // Then slowest
  for (const r of slowest) {
    if (selected.length >= 30) break;
    if (!selectedIds.has(r.taskId)) { selectedIds.add(r.taskId); selected.push(r); }
  }

  console.log(`\n${'#'.repeat(70)}`);
  console.log(`# ATLAS BENCHMARK - Phase 2 (Retry ${selected.length} hardest tasks)`);
  console.log(`# Failed: ${failed.length} | Hard: ${hard.length} | Slowest: ${selected.length - failed.length - Math.min(hard.length, 30 - failed.length)}`);
  console.log(`${'#'.repeat(70)}\n`);

  const results = [];
  for (const task of selected) {
    const result = await runTask(task);
    results.push(result);

    // Save incrementally
    fs.writeFileSync(PHASE2_FILE, JSON.stringify({
      benchmark: 'Atlas macOS Benchmark v1 - Phase 2',
      phase: 2, lastUpdated: new Date().toISOString(),
      selectedTaskIds: selected.map(s => s.taskId),
      results,
    }, null, 2));

    await sleep(2000);
  }

  // Build comparison database
  console.log('\n\nBuilding comparison database...');
  const comparison = [];
  for (const p2 of results) {
    const p1 = phase1.results.find(r => r.taskId === p2.taskId);
    comparison.push({
      taskId: p2.taskId,
      app: p2.app,
      complexity: p2.complexity,
      instruction: p2.instruction,
      phase1: {
        success: p1?.success || false,
        elapsedMs: p1?.elapsedMs || 0,
        iterations: p1?.iterations || 0,
        checkpoints: p1?.checkpoints || 0,
      },
      phase2: {
        success: p2.success,
        elapsedMs: p2.elapsedMs,
        iterations: p2.iterations,
        checkpoints: p2.checkpoints,
      },
      improvement: {
        successFlip: !p1?.success && p2.success ? 'FIXED' : (p1?.success && !p2.success ? 'REGRESSED' : 'SAME'),
        timeDelta: p1?.elapsedMs ? p2.elapsedMs - p1.elapsedMs : null,
        iterationDelta: p1?.iterations ? p2.iterations - p1.iterations : null,
        faster: p1?.elapsedMs ? p2.elapsedMs < p1.elapsedMs : null,
      },
    });
  }

  const fixed = comparison.filter(c => c.improvement.successFlip === 'FIXED').length;
  const regressed = comparison.filter(c => c.improvement.successFlip === 'REGRESSED').length;
  const faster = comparison.filter(c => c.improvement.faster === true).length;

  const db = {
    benchmark: 'Atlas Benchmark Comparison Database',
    generatedAt: new Date().toISOString(),
    summary: {
      tasksCompared: comparison.length,
      fixed, regressed,
      same: comparison.length - fixed - regressed,
      fasterCount: faster,
      slowerCount: comparison.filter(c => c.improvement.faster === false).length,
      avgTimeDeltaMs: Math.round(comparison.filter(c => c.improvement.timeDelta !== null).reduce((a, c) => a + c.improvement.timeDelta, 0) / comparison.length),
    },
    comparisons: comparison,
  };

  fs.writeFileSync(COMPARISON_FILE, JSON.stringify(db, null, 2));

  console.log(`\n${'='.repeat(70)}`);
  console.log('PHASE 2 COMPLETE');
  console.log(`${'='.repeat(70)}`);
  console.log(`Tasks retried:  ${results.length}`);
  console.log(`Fixed:          ${fixed}`);
  console.log(`Regressed:      ${regressed}`);
  console.log(`Faster:         ${faster}/${comparison.length}`);
  console.log(`Avg time delta: ${db.summary.avgTimeDeltaMs}ms`);
  console.log(`\nComparison DB:  ${COMPARISON_FILE}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
