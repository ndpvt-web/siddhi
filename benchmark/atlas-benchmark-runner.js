#!/usr/bin/env node
/**
 * atlas-benchmark-runner.js
 *
 * Runs 130 macOS benchmark tasks through Atlas's /computer/agent endpoint.
 * Collects timing, success/failure, iterations, checkpoints, trajectories.
 * Saves results to a benchmark database JSON file.
 *
 * Usage: node atlas-benchmark-runner.js [--start N] [--end N] [--phase 1|2]
 */

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

// ── Config ──
const ATLAS_HOST = 'localhost';
const ATLAS_PORT = 7890;
const ATLAS_TOKEN = 'capy_65cf825ac1bd223b561d7d080f03914c7b01546eb51f98f74fdc61a7079480d3';
const TASKS_FILE = path.join(__dirname, 'atlas-benchmark-tasks.json');
const RESULTS_DIR = path.join(__dirname, 'benchmark-results');
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 10000;
const TASK_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per task

// ── Parse CLI args ──
const args = process.argv.slice(2);
let startIdx = 0;
let endIdx = Infinity;
let phase = 1;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--start' && args[i + 1]) startIdx = parseInt(args[++i], 10);
  if (args[i] === '--end' && args[i + 1]) endIdx = parseInt(args[++i], 10);
  if (args[i] === '--phase' && args[i + 1]) phase = parseInt(args[++i], 10);
}

// ── Ensure results dir ──
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

// ── Load tasks ──
const allTasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));

// ── HTTP helper ──
function atlasRequest(endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: ATLAS_HOST,
      port: ATLAS_PORT,
      path: endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ATLAS_TOKEN}`,
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: TASK_TIMEOUT_MS,
    };

    const req = http.request(opts, (res) => {
      let chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          resolve({ status: res.statusCode, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, data: { raw } });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(data);
    req.end();
  });
}

// ── Run single task ──
async function runTask(task, attempt = 1) {
  const startTime = Date.now();
  console.log(`\n[${'='.repeat(60)}]`);
  console.log(`[Task ${task.id}/${allTasks.length}] ${task.app} (${task.complexity})`);
  console.log(`[Instruction] ${task.task}`);
  console.log(`[Attempt ${attempt}/${MAX_RETRIES + 1}]`);

  try {
    const response = await atlasRequest('/computer/agent', {
      task: task.task,
      maxIterations: 15,
    });

    const elapsed = Date.now() - startTime;
    const result = {
      taskId: task.id,
      app: task.app,
      complexity: task.complexity,
      instruction: task.task,
      phase,
      attempt,
      startTime: new Date(startTime).toISOString(),
      elapsedMs: elapsed,
      httpStatus: response.status,
      success: response.status === 200 && response.data?.success === true,
      iterations: response.data?.iterations || 0,
      checkpoints: response.data?.checkpoints?.length || 0,
      steps: response.data?.steps || [],
      trajectoryId: response.data?.trajectoryId || null,
      trajectoryViewer: response.data?.trajectoryViewer || null,
      finalText: response.data?.finalText || null,
      model: response.data?.model || null,
      escalated: response.data?.escalated || false,
      planSteps: response.data?.planSteps || null,
      error: response.data?.error || null,
    };

    console.log(`[Result] ${result.success ? 'SUCCESS' : 'FAILED'} in ${(elapsed / 1000).toFixed(1)}s | ${result.iterations} iterations | ${result.checkpoints} checkpoints`);
    if (result.error) console.log(`[Error] ${typeof result.error === 'string' ? result.error.slice(0, 200) : JSON.stringify(result.error).slice(0, 200)}`);

    return result;

  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.log(`[ERROR] ${err.message} after ${(elapsed / 1000).toFixed(1)}s`);

    if (attempt <= MAX_RETRIES && (err.message.includes('503') || err.message.includes('Timeout') || err.message.includes('ECONNREFUSED'))) {
      console.log(`[Retry] Waiting ${RETRY_DELAY_MS / 1000}s before retry...`);
      await sleep(RETRY_DELAY_MS);
      return runTask(task, attempt + 1);
    }

    return {
      taskId: task.id,
      app: task.app,
      complexity: task.complexity,
      instruction: task.task,
      phase,
      attempt,
      startTime: new Date(startTime).toISOString(),
      elapsedMs: elapsed,
      httpStatus: 0,
      success: false,
      iterations: 0,
      checkpoints: 0,
      trajectoryId: null,
      reflection: null,
      skills: null,
      error: err.message,
      finalState: null,
      sceneSummary: [],
    };
  }
}

function extractStepSummary(data) {
  if (!data || !data.steps) return [];
  return data.steps.map((s, i) => ({ step: i + 1, action: typeof s === 'string' ? s : JSON.stringify(s).slice(0, 100) }));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Aggregate stats ──
function computeStats(results) {
  const total = results.length;
  const successes = results.filter(r => r.success);
  const failures = results.filter(r => !r.success);
  const byApp = {};
  const byComplexity = {};

  for (const r of results) {
    // By app
    if (!byApp[r.app]) byApp[r.app] = { total: 0, success: 0, avgTime: 0, times: [] };
    byApp[r.app].total++;
    if (r.success) byApp[r.app].success++;
    byApp[r.app].times.push(r.elapsedMs);

    // By complexity
    if (!byComplexity[r.complexity]) byComplexity[r.complexity] = { total: 0, success: 0, avgTime: 0, times: [] };
    byComplexity[r.complexity].total++;
    if (r.success) byComplexity[r.complexity].success++;
    byComplexity[r.complexity].times.push(r.elapsedMs);
  }

  // Compute averages
  for (const key of Object.keys(byApp)) {
    byApp[key].avgTime = Math.round(byApp[key].times.reduce((a, b) => a + b, 0) / byApp[key].times.length);
    byApp[key].successRate = (byApp[key].success / byApp[key].total * 100).toFixed(1) + '%';
    delete byApp[key].times;
  }
  for (const key of Object.keys(byComplexity)) {
    byComplexity[key].avgTime = Math.round(byComplexity[key].times.reduce((a, b) => a + b, 0) / byComplexity[key].times.length);
    byComplexity[key].successRate = (byComplexity[key].success / byComplexity[key].total * 100).toFixed(1) + '%';
    delete byComplexity[key].times;
  }

  const totalTime = results.reduce((a, r) => a + r.elapsedMs, 0);
  const avgIterations = results.length > 0 ? (results.reduce((a, r) => a + r.iterations, 0) / results.length).toFixed(1) : 0;

  return {
    total,
    successes: successes.length,
    failures: failures.length,
    successRate: (successes.length / total * 100).toFixed(1) + '%',
    totalTimeMs: totalTime,
    totalTimeMin: (totalTime / 60000).toFixed(1),
    avgTaskTimeMs: Math.round(totalTime / total),
    avgIterations,
    byApp,
    byComplexity,
    topFailures: failures.map(f => ({ id: f.taskId, app: f.app, error: typeof f.error === 'string' ? f.error.slice(0, 100) : 'unknown' })),
  };
}

// ── Main ──
async function main() {
  const tasksToRun = allTasks.filter(t => t.id >= startIdx && t.id <= endIdx);
  console.log(`\n${'#'.repeat(70)}`);
  console.log(`# ATLAS BENCHMARK RUNNER - Phase ${phase}`);
  console.log(`# Tasks: ${tasksToRun.length} (IDs ${tasksToRun[0]?.id || '?'} to ${tasksToRun[tasksToRun.length - 1]?.id || '?'})`);
  console.log(`# Started: ${new Date().toISOString()}`);
  console.log(`${'#'.repeat(70)}\n`);

  const results = [];
  const resultsFile = path.join(RESULTS_DIR, `phase${phase}-results.json`);

  // Resume from existing results if any
  if (fs.existsSync(resultsFile)) {
    const existing = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
    if (existing.results) {
      results.push(...existing.results);
      console.log(`[Resume] Loaded ${results.length} existing results`);
    }
  }

  const completedIds = new Set(results.map(r => r.taskId));

  for (const task of tasksToRun) {
    if (completedIds.has(task.id)) {
      console.log(`[Skip] Task ${task.id} already completed`);
      continue;
    }

    const result = await runTask(task);
    results.push(result);

    // Save after each task (crash-resilient)
    const stats = computeStats(results);
    const output = {
      benchmark: 'Atlas macOS Benchmark v1',
      phase,
      lastUpdated: new Date().toISOString(),
      stats,
      results,
    };
    fs.writeFileSync(resultsFile, JSON.stringify(output, null, 2));
    console.log(`[Saved] ${resultsFile} (${results.length} results)`);

    // Brief pause between tasks to let system settle
    await sleep(2000);
  }

  // Final summary
  const finalStats = computeStats(results);
  console.log(`\n${'='.repeat(70)}`);
  console.log(`BENCHMARK COMPLETE - Phase ${phase}`);
  console.log(`${'='.repeat(70)}`);
  console.log(`Total tasks:    ${finalStats.total}`);
  console.log(`Successes:      ${finalStats.successes} (${finalStats.successRate})`);
  console.log(`Failures:       ${finalStats.failures}`);
  console.log(`Total time:     ${finalStats.totalTimeMin} minutes`);
  console.log(`Avg time/task:  ${(finalStats.avgTaskTimeMs / 1000).toFixed(1)}s`);
  console.log(`Avg iterations: ${finalStats.avgIterations}`);
  console.log(`\nBy Complexity:`);
  for (const [k, v] of Object.entries(finalStats.byComplexity)) {
    console.log(`  ${k}: ${v.successRate} (${v.success}/${v.total}), avg ${(v.avgTime / 1000).toFixed(1)}s`);
  }
  console.log(`\nBy App:`);
  for (const [k, v] of Object.entries(finalStats.byApp)) {
    console.log(`  ${k}: ${v.successRate} (${v.success}/${v.total}), avg ${(v.avgTime / 1000).toFixed(1)}s`);
  }
  if (finalStats.topFailures.length > 0) {
    console.log(`\nTop Failures:`);
    for (const f of finalStats.topFailures.slice(0, 10)) {
      console.log(`  Task ${f.id} (${f.app}): ${f.error}`);
    }
  }
  console.log(`\nResults saved to: ${resultsFile}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
