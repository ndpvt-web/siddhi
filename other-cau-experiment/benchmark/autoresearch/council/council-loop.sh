#!/usr/bin/env bash
#
# Atlas Optimization Council - Auto-Research Loop
#
# Iterative optimization using a 3-model committee:
#   ANALYZE -> HYPOTHESIZE -> DEBATE -> IMPLEMENT -> TEST -> EVALUATE -> KEEP/REVERT
#
# Each iteration creates a git branch. Successful changes merge to main.
# Convergence: stops after 2 consecutive iterations with no improvement.
#
# Usage: bash council-loop.sh [--max-iterations N] [--test-tasks N]
#

set -uo pipefail
# NOTE: not using -e (errexit) because git/revert operations need to tolerate failures

ATLAS_ROOT="/Users/nivesh/Projects/atlas-copy"
BENCHMARK_DIR="$ATLAS_ROOT/benchmark"
COUNCIL_DIR="$BENCHMARK_DIR/autoresearch/council"
STATE_FILE="$BENCHMARK_DIR/autoresearch/council-state.json"
LOG_FILE="/tmp/council-autoresearch.log"
ENGINE="$BENCHMARK_DIR/autoresearch/council/engine.js"

MAX_ITERATIONS=${1:-10}
TEST_TASK_COUNT=15
ATLAS_PORT=7890
ATLAS_TOKEN=$(cat "$ATLAS_ROOT/.token")
CONVERGENCE_THRESHOLD=2  # Stop after N consecutive no-improvement iterations

# --- Logging ---
log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
  echo "$msg"
  echo "$msg" >> "$LOG_FILE"
}

# --- State Management ---
init_state() {
  if [ ! -f "$STATE_FILE" ]; then
    echo '{"iteration":0,"history":[],"bestSuccessRate":0,"convergenceCount":0,"status":"idle"}' > "$STATE_FILE"
  fi
}

read_state() {
  python3 -c "import json; d=json.load(open('$STATE_FILE')); print(d.get('$1', '$2'))"
}

update_state() {
  python3 -c "
import json
d = json.load(open('$STATE_FILE'))
d['$1'] = $2
json.dump(d, open('$STATE_FILE', 'w'), indent=2)
"
}

# --- Run a subset of benchmark tasks ---
run_test_subset() {
  local tasks_json="$1"
  local output_file="$2"

  log "Running test subset ($TEST_TASK_COUNT tasks)..."

  # Build a mini benchmark runner inline
  node -e "
const https = require('https');
const http = require('http');
const fs = require('fs');

const tasks = JSON.parse(fs.readFileSync('$BENCHMARK_DIR/atlas-benchmark-tasks.json', 'utf8'));
const testTaskIds = JSON.parse('$tasks_json');
const port = $ATLAS_PORT;
const token = '$ATLAS_TOKEN';

async function runTask(task) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ task: task.task, maxIterations: 15 });
    const options = {
      hostname: 'localhost', port, path: '/computer/agent', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    };
    const startTime = Date.now();
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve({ taskId: task.id, task: task.task, success: result.success || false, iterations: result.iterations || 0, duration: Date.now() - startTime });
        } catch(e) { resolve({ taskId: task.id, task: task.task, success: false, error: e.message, duration: Date.now() - startTime }); }
      });
    });
    req.on('error', e => resolve({ taskId: task.id, task: task.task, success: false, error: e.message, duration: Date.now() - startTime }));
    req.setTimeout(180000, () => { req.destroy(); resolve({ taskId: task.id, task: task.task, success: false, error: 'timeout', duration: 180000 }); });
    req.write(payload);
    req.end();
  });
}

(async () => {
  const selected = tasks.filter(t => testTaskIds.includes(t.id));
  // If council didn't provide valid task IDs, pick from failures
  const toRun = selected.length >= 5 ? selected : tasks.slice(0, $TEST_TASK_COUNT);
  const results = [];
  for (const task of toRun) {
    console.error('  Testing: ' + task.id + ' - ' + task.task.slice(0, 60));
    const r = await runTask(task);
    results.push(r);
    console.error('    ' + (r.success ? 'PASS' : 'FAIL'));
  }
  const output = {
    timestamp: new Date().toISOString(),
    results,
    stats: {
      total: results.length,
      successes: results.filter(r => r.success).length,
      failures: results.filter(r => !r.success).length,
      successRate: ((results.filter(r => r.success).length / results.length) * 100).toFixed(1) + '%'
    }
  };
  fs.writeFileSync('$output_file', JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output.stats));
})();
" 2>&1 | tee -a "$LOG_FILE"
}

# --- Apply a code change from the council decision ---
apply_change() {
  local decision_file="$COUNCIL_DIR/decision.json"

  log "Applying winning proposal..."

  python3 -c "
import json, os

d = json.load(open('$decision_file'))
proposal = d.get('winnerProposal', {})
change = proposal.get('change', {})
target = proposal.get('targetFile', '')

if not target or not change:
    print('ERROR: No valid change in proposal')
    exit(1)

# Resolve path
if not target.startswith('/'):
    target = os.path.join('$ATLAS_ROOT', target)

if not os.path.exists(target):
    print(f'ERROR: Target file not found: {target}')
    exit(1)

content = open(target).read()
change_type = change.get('type', 'replace')

if change_type == 'replace' and change.get('oldCode'):
    if change['oldCode'] not in content:
        print(f'WARNING: oldCode not found in {target}, attempting fuzzy match...')
        # Try trimmed match
        old_trimmed = change['oldCode'].strip()
        lines = content.split('\n')
        for i, line in enumerate(lines):
            if old_trimmed in line or line.strip() in old_trimmed:
                print(f'  Fuzzy match at line {i+1}')
                break
        else:
            print('ERROR: Could not find code to replace')
            exit(1)
    content = content.replace(change['oldCode'], change.get('newCode', ''), 1)
elif change_type == 'insert':
    loc = change.get('location', '')
    new_code = change.get('newCode', '')
    if 'after' in loc.lower():
        # Try to insert after specified location
        marker = loc.split('after')[-1].strip().strip(':').strip('\"').strip()
        if marker in content:
            idx = content.index(marker) + len(marker)
            # Find end of line
            nl = content.index('\n', idx) if '\n' in content[idx:] else len(content)
            content = content[:nl+1] + new_code + '\n' + content[nl+1:]
        else:
            content = content + '\n' + new_code + '\n'
    else:
        content = content + '\n' + new_code + '\n'
elif change_type == 'append':
    content = content + '\n' + change.get('newCode', '') + '\n'

open(target, 'w').write(content)
print(f'Applied {change_type} to {target}')
" 2>&1 | tee -a "$LOG_FILE"
}

# --- Main Loop ---
main() {
  log "=== Atlas Optimization Council - Starting ==="
  log "Max iterations: $MAX_ITERATIONS"

  mkdir -p "$COUNCIL_DIR"
  init_state

  local iteration=$(read_state iteration 0)
  local convergence_count=$(read_state convergenceCount 0)
  local best_rate=$(read_state bestSuccessRate 0)

  while [ "$iteration" -lt "$MAX_ITERATIONS" ]; do
    iteration=$((iteration + 1))
    local branch_name="autoresearch/iter-${iteration}"

    log ""
    log "=========================================="
    log "ITERATION $iteration / $MAX_ITERATIONS"
    log "=========================================="

    update_state iteration "$iteration"
    update_state status '"running"'

    # --- Step 1: Analyze ---
    log "Phase 1: ANALYZE"
    node "$ENGINE" analyze 2>&1 | tee -a "$LOG_FILE"

    # --- Step 2: Hypothesize ---
    log "Phase 2: HYPOTHESIZE (3 models)"
    export AI_GATEWAY_API_KEY="${AI_GATEWAY_API_KEY}"
    node "$ENGINE" hypothesize 2>&1 | tee -a "$LOG_FILE"

    # --- Step 3: Debate ---
    log "Phase 3: DEBATE & SELECT"
    node "$ENGINE" debate 2>&1 | tee -a "$LOG_FILE"

    # Check if we got a valid decision
    if [ ! -f "$COUNCIL_DIR/decision.json" ]; then
      log "ERROR: No decision produced. Skipping iteration."
      continue
    fi

    # Extract test task IDs from decision
    local test_tasks=$(python3 -c "import json; d=json.load(open('$COUNCIL_DIR/decision.json')); print(json.dumps(d.get('testTasks', [])))")

    # --- Step 4: Run BEFORE test (baseline) ---
    log "Phase 4a: BASELINE TEST"
    run_test_subset "$test_tasks" "$COUNCIL_DIR/test-before.json"

    # --- Step 5: Create branch and apply change ---
    log "Phase 4b: CREATE BRANCH & APPLY"
    cd "$ATLAS_ROOT"
    git checkout -b "$branch_name" 2>/dev/null || git checkout "$branch_name"

    apply_change

    # Commit the change
    git add -A
    git commit -m "autoresearch iter-${iteration}: $(python3 -c "import json; print(json.load(open('$COUNCIL_DIR/decision.json')).get('winnerProposal',{}).get('hypothesis','unknown')[:80])")" 2>&1 | tee -a "$LOG_FILE"

    # --- Step 6: Restart Atlas with changes ---
    log "Phase 4c: RESTART ATLAS"
    local atlas_pid=$(lsof -ti :$ATLAS_PORT 2>/dev/null || true)
    if [ -n "$atlas_pid" ]; then
      kill "$atlas_pid" 2>/dev/null || true
      sleep 2
    fi
    cd "$ATLAS_ROOT"
    CAPY_BRIDGE_PORT=$ATLAS_PORT nohup node server.js > /tmp/atlas-server.log 2>&1 &
    sleep 4

    # Verify Atlas is running (health check + smoke test)
    local health_ok=false
    for i in 1 2 3; do
      if curl -s "http://localhost:$ATLAS_PORT/health" > /dev/null 2>&1; then
        health_ok=true
        break
      fi
      sleep 2
    done
    if [ "$health_ok" = false ]; then
      log "ERROR: Atlas failed to restart. Reverting."
      git reset HEAD . 2>/dev/null || true
      git checkout -- . 2>/dev/null || true
      git clean -fd 2>/dev/null || true
      git checkout main 2>/dev/null || true
      git branch -D "$branch_name" 2>/dev/null || true
      CAPY_BRIDGE_PORT=$ATLAS_PORT nohup node server.js > /tmp/atlas-server.log 2>&1 &
      sleep 4
      continue
    fi

    # --- Step 7: Run AFTER test ---
    log "Phase 5: POST-CHANGE TEST"
    run_test_subset "$test_tasks" "$COUNCIL_DIR/test-after.json"

    # --- Step 8: Evaluate ---
    log "Phase 6: EVALUATE (3 judges)"
    node "$ENGINE" evaluate 2>&1 | tee -a "$LOG_FILE"

    # Read verdict
    local verdict=$(python3 -c "import json; print(json.load(open('$COUNCIL_DIR/evaluation.json')).get('verdict','REVERT'))")
    local after_rate=$(python3 -c "import json; d=json.load(open('$COUNCIL_DIR/test-after.json')); print(float(d['stats']['successRate'].replace('%','')))")

    if [ "$verdict" = "KEEP" ]; then
      log "VERDICT: KEEP - Merging to main"
      git add -A && git commit -m "council iter-${iteration}: test artifacts" --allow-empty 2>/dev/null || true
      git checkout main
      git merge "$branch_name" -m "council: merge iter-${iteration} improvement"

      # Restart Atlas on main
      atlas_pid=$(lsof -ti :$ATLAS_PORT 2>/dev/null || true)
      if [ -n "$atlas_pid" ]; then kill "$atlas_pid" 2>/dev/null || true; sleep 2; fi
      cd "$ATLAS_ROOT"
      CAPY_BRIDGE_PORT=$ATLAS_PORT nohup node server.js > /tmp/atlas-server.log 2>&1 &
      sleep 4

      # Update best rate
      if (( $(echo "$after_rate > $best_rate" | bc -l) )); then
        best_rate="$after_rate"
        update_state bestSuccessRate "$after_rate"
        convergence_count=0
      else
        convergence_count=$((convergence_count + 1))
      fi
    else
      log "VERDICT: REVERT - Discarding branch"
      # Clean working tree before switching branches
      git reset HEAD . 2>/dev/null || true
      git checkout -- . 2>/dev/null || true
      git clean -fd 2>/dev/null || true
      git checkout main 2>/dev/null || true
      git branch -D "$branch_name" 2>/dev/null || true

      # Restart Atlas on main (clean)
      atlas_pid=$(lsof -ti :$ATLAS_PORT 2>/dev/null || true)
      if [ -n "$atlas_pid" ]; then kill "$atlas_pid" 2>/dev/null || true; sleep 2; fi
      cd "$ATLAS_ROOT"
      CAPY_BRIDGE_PORT=$ATLAS_PORT nohup node server.js > /tmp/atlas-server.log 2>&1 &
      sleep 4

      convergence_count=$((convergence_count + 1))
    fi

    # Archive iteration artifacts
    local iter_dir="$BENCHMARK_DIR/autoresearch/council/iterations/iter-${iteration}"
    mkdir -p "$iter_dir"
    for f in analysis.json proposals.json decision.json evaluation.json test-before.json test-after.json; do
      [ -f "$COUNCIL_DIR/$f" ] && cp "$COUNCIL_DIR/$f" "$iter_dir/"
    done

    # Update state with history entry
    python3 -c "
import json
d = json.load(open('$STATE_FILE'))
d['convergenceCount'] = $convergence_count
d['history'].append({
    'iteration': $iteration,
    'hypothesis': json.load(open('$COUNCIL_DIR/decision.json')).get('winnerProposal',{}).get('hypothesis','unknown'),
    'verdict': '$verdict',
    'result': '$verdict',
    'successRate': '$after_rate%',
    'winner': json.load(open('$COUNCIL_DIR/decision.json')).get('winner','unknown')
})
json.dump(d, open('$STATE_FILE', 'w'), indent=2)
"

    update_state iteration "$iteration"

    log "Iteration $iteration complete. Verdict: $verdict. Convergence: $convergence_count/$CONVERGENCE_THRESHOLD"

    # --- Convergence Check ---
    if [ "$convergence_count" -ge "$CONVERGENCE_THRESHOLD" ]; then
      log ""
      log "=== CONVERGENCE REACHED ==="
      log "$CONVERGENCE_THRESHOLD consecutive iterations with no improvement."
      log "Best success rate: ${best_rate}%"
      log "Stopping auto-research."
      update_state status '"converged"'
      break
    fi

    log "Sleeping 10s before next iteration..."
    sleep 10
  done

  # Final summary
  log ""
  log "=== COUNCIL AUTO-RESEARCH COMPLETE ==="
  log "Total iterations: $iteration"
  log "Best success rate: ${best_rate}%"

  python3 -c "
import json
d = json.load(open('$STATE_FILE'))
kept = [h for h in d['history'] if h['verdict'] == 'KEEP']
reverted = [h for h in d['history'] if h['verdict'] == 'REVERT']
print(f'Kept: {len(kept)} changes')
for k in kept:
    print(f'  - Iter {k[\"iteration\"]}: {k[\"hypothesis\"]}')
print(f'Reverted: {len(reverted)} changes')
"

  update_state status '"complete"'
}

main "$@"
