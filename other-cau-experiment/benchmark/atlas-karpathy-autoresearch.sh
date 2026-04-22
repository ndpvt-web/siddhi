#!/bin/bash
# atlas-karpathy-autoresearch.sh
#
# Dynamic action-test-reflect-feedback optimization loop.
# NOT hardcoded strategies -- each iteration is driven by real-time
# feedback from the previous iteration's test results.
#
# Loop: ANALYZE -> HYPOTHESIZE -> IMPLEMENT -> TEST -> REFLECT -> REPEAT
#
# Each step uses Claude Code CLI VISIBLY in Terminal.app.
# Claude reads the actual results and decides what to try next.
#
# Usage: bash atlas-karpathy-autoresearch.sh [max_iterations]

set -e

ATLAS_DIR="/Users/nivesh/Projects/atlas-copy"
BENCHMARK_DIR="$ATLAS_DIR/benchmark"
RESULTS_DIR="$BENCHMARK_DIR/benchmark-results"
RESEARCH_DIR="$BENCHMARK_DIR/autoresearch"
MAX_LOOPS=${1:-5}  # Default 5 optimization loops

mkdir -p "$RESEARCH_DIR"

# Track iteration state
ITERATION=0
LOOP_STATE="$RESEARCH_DIR/loop-state.json"

# Initialize loop state if first run
if [ ! -f "$LOOP_STATE" ]; then
  echo '{"iteration":0,"history":[],"bestSuccessRate":0,"convergenceCount":0}' > "$LOOP_STATE"
fi

echo ""
echo "============================================================"
echo "  KARPATHY AUTO-RESEARCH: Dynamic Optimization Loop"
echo "  Max iterations: $MAX_LOOPS"
echo "  Started: $(date)"
echo "============================================================"
echo ""

# The CORE LOOP prompt template - Claude decides everything dynamically
LOOP_PROMPT_TEMPLATE='You are an autonomous optimization researcher for the Atlas computer-use agent system.

## YOUR MISSION
Improve Atlas success rate on macOS benchmark tasks through iterative experimentation.

## CURRENT STATE
Iteration: ITER_NUM of MAX_ITER
Previous iterations history: HISTORY_JSON

## AVAILABLE DATA
- Phase 1 results: RESULTS_DIR/phase1-results.json (benchmark data with success/failure per task)
- Previous iteration logs: RESEARCH_DIR/iteration-*/
- Atlas source code: ATLAS_DIR/modules/ (computer-use.js, ax-grounding.js, trajectory.js, brain.js, etc.)
- Context manager: ATLAS_DIR/context-manager.js

## YOUR PROCESS (do ALL of these, in order)

### 1. ANALYZE (read the data)
Read the benchmark results. Identify:
- Current success rate and failure patterns
- What changed since last iteration (if any)
- Specific error types and which apps/tasks fail

### 2. HYPOTHESIZE (decide what to try)
Based on the ACTUAL DATA (not assumptions), form ONE specific hypothesis:
- "I think [specific change] will fix [specific failure pattern] because [reasoning from data]"
- Pick the highest-impact, safest change
- If previous iteration made things worse, REVERT it first

### 3. IMPLEMENT (make the change)
- Create backup: cp file file.bak-iter-ITER_NUM
- Make ONE focused code change
- Verify with: node -c <file>
- Write what you changed to RESEARCH_DIR/iteration-ITER_NUM/change.md

### 4. TEST (run affected tasks)
Run the benchmark on 5-10 tasks most likely affected by your change:
  cd BENCHMARK_DIR && node atlas-benchmark-runner.js --start <ID> --end <ID> --phase PHASE_NUM
Wait for results (each task takes ~2 min).

### 5. REFLECT (evaluate results)
Read the test results. Write honest reflection to RESEARCH_DIR/iteration-ITER_NUM/reflection.md:
- Did the change improve things? By how much?
- Any regressions?
- What does this tell us about the system?
- What should the NEXT iteration try?

### 6. UPDATE STATE
Write updated state to LOOP_STATE_FILE:
{
  "iteration": ITER_NUM,
  "hypothesis": "what you tried",
  "change": "what code you changed",
  "result": "improved/regressed/neutral",
  "successRateBefore": X,
  "successRateAfter": Y,
  "nextSuggestion": "what to try next based on this result",
  "history": [... previous + this iteration]
}

IMPORTANT RULES:
- ONLY make changes based on what the DATA tells you, never pre-scripted
- ONE change per iteration (isolate variables)
- If something regresses, REVERT immediately
- Read actual error messages and step logs, dont guess
- Be honest in reflections -- if something didnt work, say so
- Focus on: action reliability, element detection, navigation accuracy, timeout handling'

while [ "$ITERATION" -lt "$MAX_LOOPS" ]; do
  ITERATION=$((ITERATION + 1))
  PHASE_NUM=$((ITERATION + 10))  # Use phase 11, 12, 13... for each iteration
  ITER_DIR="$RESEARCH_DIR/iteration-$ITERATION"
  mkdir -p "$ITER_DIR"

  echo ""
  echo "============================================================"
  echo "  ITERATION $ITERATION / $MAX_LOOPS"
  echo "  $(date)"
  echo "============================================================"

  # Read current history
  HISTORY=$(cat "$LOOP_STATE" 2>/dev/null || echo '{}')

  # Build the prompt with real values substituted
  PROMPT=$(echo "$LOOP_PROMPT_TEMPLATE" | \
    sed "s|ITER_NUM|$ITERATION|g" | \
    sed "s|MAX_ITER|$MAX_LOOPS|g" | \
    sed "s|RESULTS_DIR|$RESULTS_DIR|g" | \
    sed "s|RESEARCH_DIR|$RESEARCH_DIR|g" | \
    sed "s|ATLAS_DIR|$ATLAS_DIR|g" | \
    sed "s|BENCHMARK_DIR|$BENCHMARK_DIR|g" | \
    sed "s|PHASE_NUM|$PHASE_NUM|g" | \
    sed "s|LOOP_STATE_FILE|$LOOP_STATE|g" | \
    sed "s|HISTORY_JSON|$HISTORY|g")

  # Write prompt to file (avoids shell escaping issues with osascript)
  PROMPT_FILE="$ITER_DIR/prompt.txt"
  echo "$PROMPT" > "$PROMPT_FILE"

  # Run Claude Code VISIBLY in Terminal.app
  osascript -e "
tell application \"Terminal\"
  activate
  do script \"cd $ATLAS_DIR && echo '=== ITERATION $ITERATION ===' && claude -p \\\"\$(cat $PROMPT_FILE)\\\" 2>&1 | tee $ITER_DIR/output.log; echo '=== ITERATION $ITERATION COMPLETE ==='\"
end tell
"

  echo "  Claude Code running iteration $ITERATION in visible Terminal..."
  echo "  Watching for completion..."

  # Wait for this iteration to complete
  WAIT_COUNT=0
  MAX_WAIT=120  # 120 * 15s = 30 minutes max per iteration
  while [ "$WAIT_COUNT" -lt "$MAX_WAIT" ]; do
    if grep -q "ITERATION $ITERATION COMPLETE" "$ITER_DIR/output.log" 2>/dev/null; then
      echo "  Iteration $ITERATION finished!"
      break
    fi
    sleep 15
    WAIT_COUNT=$((WAIT_COUNT + 1))
    if [ $((WAIT_COUNT % 4)) -eq 0 ]; then
      echo "  Still running... ($(($WAIT_COUNT * 15))s elapsed)"
    fi
  done

  if [ "$WAIT_COUNT" -ge "$MAX_WAIT" ]; then
    echo "  WARNING: Iteration $ITERATION timed out after 30 minutes"
    echo '{"timeout": true}' > "$ITER_DIR/reflection.md"
  fi

  # Check if we should stop early (convergence detection)
  if [ -f "$LOOP_STATE" ]; then
    CONVERGED=$(python3 -c "
import json
try:
  d = json.load(open('$LOOP_STATE'))
  # Stop if 2 consecutive iterations show no improvement
  h = d.get('history', [])
  if len(h) >= 2:
    last_two = h[-2:]
    if all(r.get('result') in ['neutral', 'regressed'] for r in last_two):
      print('yes')
    else:
      print('no')
  else:
    print('no')
except:
  print('no')
" 2>/dev/null)

    if [ "$CONVERGED" = "yes" ]; then
      echo ""
      echo "  CONVERGENCE DETECTED: 2 iterations with no improvement."
      echo "  Stopping optimization loop early."
      break
    fi
  fi

  echo ""
  sleep 5
done

# Final summary
echo ""
echo "============================================================"
echo "  AUTO-RESEARCH COMPLETE"
echo "  Iterations run: $ITERATION"
echo "  $(date)"
echo "============================================================"

# Generate final summary using Claude
FINAL_PROMPT="Read all iteration results in $RESEARCH_DIR/iteration-*/reflection.md and $LOOP_STATE.
Write a concise final research report to $RESEARCH_DIR/final-report.md covering:
1. Starting baseline vs final performance
2. What optimizations worked and which didnt
3. Key insights about the Atlas architecture
4. Remaining failure modes
5. Recommendations for future improvement"

FINAL_PROMPT_FILE="$RESEARCH_DIR/final-prompt.txt"
echo "$FINAL_PROMPT" > "$FINAL_PROMPT_FILE"

osascript -e "
tell application \"Terminal\"
  activate
  do script \"cd $ATLAS_DIR && claude -p \\\"\$(cat $FINAL_PROMPT_FILE)\\\" 2>&1 | tee $RESEARCH_DIR/final-output.log; echo '=== FINAL REPORT COMPLETE ==='\"
end tell
"

echo "  Generating final report in visible Terminal..."
echo "  Results will be in: $RESEARCH_DIR/"
echo "============================================================"
