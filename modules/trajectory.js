/**
 * Trajectory Graph - Agent execution tracking with graph-theoretic state management
 *
 * Treats computer-use agent execution as graph traversal:
 *   - Each screenshot = a STATE NODE (vertex in the state graph)
 *   - Each action = an EDGE (transition between states)
 *   - Hashing enables LOOP DETECTION (cycle detection in the graph)
 *   - Stagnation detection: action had no effect (self-loop / identity edge)
 *   - CHECKPOINT system: verified-good states marked as safe return points
 *   - TASK PLAN tracking: DAG of sub-goals with completion status
 *   - RECOVERY LEVELS: escalating backtracking strategies (0-3)
 *   - Forensic trail: every step logged with screenshot on disk
 *   - HTML viewer: visual graph of the entire trajectory
 *
 * Graph Theory Concepts Used:
 *   - Cycle detection (DFS back-edge detection via hash matching)
 *   - Checkpoints (marked vertices in the graph for backtracking)
 *   - Recovery = finding shortest path back to a checkpoint vertex
 *   - Task DAG = directed acyclic graph of sub-goals with dependencies
 *
 * Usage:
 *   const traj = new TrajectoryGraph('task-123', 'open Safari and search');
 *   traj.addNode(screenshotBase64, null, null);           // initial state
 *   traj.setTaskPlan([{n:1, desc:'Open Safari'}, {n:2, desc:'Search google'}]);
 *   const loop = traj.addNode(screenshotBase64, action, result);
 *   if (loop.loopDetected) { ... try different action ... }
 *   traj.addCheckpoint(1, 'Safari is open');              // mark verified state
 *   traj.complete(true, 'Searched google successfully');
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const os = require('os');

const TRAJECTORY_DIR = path.join(os.homedir(), '.capy-trajectories');

class TrajectoryGraph {
  constructor(taskId, taskDescription = '') {
    this.taskId = taskId || `task-${Date.now()}`;
    this.taskDescription = taskDescription;
    this.nodes = [];
    this.edges = [];
    this.startTime = Date.now();
    this.endTime = null;
    this.success = null;
    this.finalText = '';
    this.loopsDetected = 0;
    this.stagnationsDetected = 0;

    // === CHECKPOINT SYSTEM (graph backtracking support) ===
    this.checkpoints = [];       // { stepNumber, description, nodeId, nodeIndex, screenshotHash, timestamp }
    this.taskPlan = null;        // { steps: [{n, desc, done}], totalSteps }
    this.currentStep = 0;        // Which plan step the agent is working on
    this.consecutiveIssues = 0;  // Consecutive loops/stagnations without progress (resets on checkpoint)
    this._expectNavigation = false;  // PATCH: Set externally to suppress surprise for navigation actions
    this.surprisesDetected = 0;  // Count of frames where observation didn't match expectation

    // === BRANCHING SYSTEM (retrospective annotations on the timeline) ===
    // Branches label frame ranges after the fact. The agent doesn't need to know about them.
    // When backtracking occurs, the failed segment becomes a closed branch with a lesson,
    // and a new branch starts from the checkpoint the agent returns to.
    this.branches = [{
      id: 'branch-0-main',
      name: 'main',
      index: 0,
      baseFrameIndex: 0,    // Which frame this branch starts from
      startFrameIndex: 0,   // First frame belonging to this branch
      tipFrameIndex: 0,     // Latest frame in this branch (updated on each addNode)
      status: 'exploring',  // 'exploring' | 'succeeded' | 'failed'
      approach: 'initial attempt',
      outcome: null,
      lesson: null,
    }];
    this.activeBranchIndex = 0;  // Index into this.branches

    this.screenshotDir = path.join(TRAJECTORY_DIR, this.taskId);
    fs.mkdirSync(this.screenshotDir, { recursive: true });
  }

  // ============================================================
  // NODE MANAGEMENT
  // ============================================================

  /**
   * Add a node to the trajectory graph.
   * Returns { nodeId, loopDetected, stagnationDetected, matchedNodeId }
   *
   * @param {string} screenshotBase64 - Base64 encoded screenshot
   * @param {object} action - Action taken (computer_use tool call)
   * @param {object} toolResult - Result from the tool
   * @param {object} axContext - Optional AX context from Phase 0 (AXQueryResult)
   */
  addNode(screenshotBase64, action, toolResult, axContext = null) {
    const nodeIndex = this.nodes.length;
    const nodeId = `step-${nodeIndex}`;
    const parentId = nodeIndex > 0 ? `step-${nodeIndex - 1}` : null;

    // Save screenshot to disk and compute hashes
    let screenshotPath = null;
    let exactHash = null;
    let thumbnailHash = null;

    if (screenshotBase64) {
      screenshotPath = path.join(this.screenshotDir, `${nodeId}.png`);
      const imgBuffer = Buffer.from(screenshotBase64, 'base64');
      fs.writeFileSync(screenshotPath, imgBuffer);

      // Exact hash (MD5 of full image)
      exactHash = crypto.createHash('md5').update(imgBuffer).digest('hex');

      // Thumbnail hash for perceptual comparison (resize to 32x32 with sips)
      thumbnailHash = this._computeThumbnailHash(screenshotPath);
    }

    const node = {
      id: nodeId,
      index: nodeIndex,
      parentId,
      timestamp: Date.now(),
      relativeTime: Date.now() - this.startTime,
      screenshotPath,
      exactHash,
      thumbnailHash,
      action: action ? this._summarizeAction(action) : null,
      toolResult: toolResult ? this._summarizeResult(toolResult) : null,
      flags: [],
      expectation: null,     // What the agent expected BEFORE this screenshot
      surprise: null,        // { score: 0-1, expected: string, observed: string }
      branch: this.branches[this.activeBranchIndex]?.id || 'branch-0-main',
      semanticState: null,  // LLM-generated 1-sentence description (set via SCENE markers)
      resolvedTarget: null,   // AX-resolved element name for click actions (e.g., "Save button")
      assistantIntent: null,  // LLM's stated intent before this action (from assistant message)
      axContext: axContext || null, // Phase 0 AX semantic data (app, focusedElement)
    };

    this.nodes.push(node);

    // Auto-generate semantic state from action (will be overridden by SCENE marker if present)
    this._autoSemanticState(node);

    // Update active branch tip
    if (this.branches[this.activeBranchIndex]) {
      this.branches[this.activeBranchIndex].tipFrameIndex = nodeIndex;
    }

    // Add edge from parent
    if (parentId && action) {
      this.edges.push({
        from: parentId,
        to: nodeId,
        action: this._summarizeAction(action),
        timestamp: Date.now(),
      });
    }

    // === LOOP DETECTION ===
    const loopResult = this._detectLoop(node);
    if (loopResult) {
      node.flags.push('loop');
      this.loopsDetected++;
      console.log(`[Trajectory] LOOP DETECTED at ${nodeId}: same screen as ${loopResult.matchedNodeId} (${loopResult.stepsBack} steps back)`);
    }

    // === STAGNATION DETECTION ===
    const stagnation = this._detectStagnation(node);
    if (stagnation) {
      node.flags.push('stagnation');
      this.stagnationsDetected++;
      console.log(`[Trajectory] STAGNATION at ${nodeId}: action had no visible effect`);
    }

    // === SURPRISE DETECTION (with navigation suppression) ===
    // If the previous node had an expectation set, compute surprise for THIS node.
    // PATCH: If _expectNavigation was set by computer-use.js, suppress surprise entirely.
    //   Browser navigation (Return, type+newline, link clicks) ALWAYS changes the page.
    //   This is EXPECTED behavior, not a surprise.
    const isNavAction = this._expectNavigation;
    this._expectNavigation = false;  // Reset after reading
    if (isNavAction) {
      node.flags.push('navigation');
      console.log('[Trajectory] NAV action at ' + nodeId + ': surprise suppressed (expected page change)');
    }
    const surpriseResult = isNavAction ? null : this._computeSurprise(node);
    if (surpriseResult && surpriseResult.score > 0.5) {
      node.flags.push('surprise');
      node.surprise = surpriseResult;
      this.surprisesDetected++;
      this.consecutiveIssues++; // Surprises count as issues for recovery
      console.log(`[Trajectory] SURPRISE at ${nodeId}: score=${surpriseResult.score.toFixed(2)} (expected: "${surpriseResult.expected.slice(0, 60)}...")`);
    } else if (surpriseResult) {
      node.surprise = surpriseResult; // Store even low-surprise for forensics
    }

    return {
      nodeId,
      loopDetected: !!loopResult,
      stagnationDetected: !!stagnation,
      surpriseDetected: !!(surpriseResult && surpriseResult.score > 0.5),
      surpriseScore: surpriseResult?.score || 0,
      matchedNodeId: loopResult?.matchedNodeId || null,
      stepsBack: loopResult?.stepsBack || 0,
    };
  }

  // ============================================================
  // LOOP DETECTION (cycle detection in the state graph)
  // ============================================================

  /**
   * Adaptive lookback window for cycle detection.
   *
   * Derivation (first principles):
   *   - A loop of period P requires lookback >= P to detect.
   *   - We don't know P, but expect loops proportional to task complexity.
   *   - For N total nodes: lookback = max(10, floor(N * 0.6))
   *     - 10 is the minimum (catches short loops in early execution)
   *     - 60% of history covers loops up to 60% of execution length
   *     - Beyond 60%, the state has likely diverged enough that hash collision is noise
   *   - Cap at 50 to bound O(N) scan cost per node addition.
   *
   * @param {number} totalNodes - Current number of nodes in the graph
   * @returns {number} - Lookback window size
   */
  _adaptiveLookback(totalNodes) {
    return Math.min(50, Math.max(10, Math.floor(totalNodes * 0.6)));
  }

  _detectLoop(currentNode) {
    if (!currentNode.exactHash) return null;

    const lookback = this._adaptiveLookback(this.nodes.length);
    const startIdx = Math.max(0, currentNode.index - lookback);
    for (let i = currentNode.index - 2; i >= startIdx; i--) {
      const ancestor = this.nodes[i];

      // Exact match
      if (ancestor.exactHash && ancestor.exactHash === currentNode.exactHash) {
        return {
          matchedNodeId: ancestor.id,
          stepsBack: currentNode.index - i,
          matchType: 'exact',
        };
      }

      // Thumbnail match (perceptual - catches minor differences)
      if (ancestor.thumbnailHash && currentNode.thumbnailHash &&
          ancestor.thumbnailHash === currentNode.thumbnailHash) {
        return {
          matchedNodeId: ancestor.id,
          stepsBack: currentNode.index - i,
          matchType: 'perceptual',
        };
      }
    }

    return null;
  }

  // ============================================================
  // STAGNATION DETECTION (action had no effect)
  // ============================================================

  _detectStagnation(currentNode) {
    if (currentNode.index < 1) return false;
    const prevNode = this.nodes[currentNode.index - 1];

    // If current screenshot matches the immediately previous one,
    // the action between them had no visible effect
    if (currentNode.exactHash && prevNode.exactHash &&
        currentNode.exactHash === prevNode.exactHash &&
        currentNode.action) {
      return true;
    }

    return false;
  }

  // ============================================================
  // EXPECTATION / SURPRISE SYSTEM
  // ============================================================

  /**
   * Store the agent's expectation on the CURRENT (latest) node.
   * Called when we parse an EXPECT: marker from the agent's text output.
   * The expectation describes what the agent expects to see AFTER its next action.
   * Surprise is computed on the NEXT addNode() call.
   *
   * @param {string} expectationText - What the agent expects (e.g., "System Settings window should be open")
   */
  setExpectation(expectationText) {
    const currentNode = this.nodes[this.nodes.length - 1];
    if (!currentNode) return;
    currentNode.expectation = expectationText;
    console.log(`[Trajectory] EXPECT set on ${currentNode.id}: "${expectationText.slice(0, 80)}"`);
  }

  // ============================================================
  // BRANCHING SYSTEM
  // ============================================================

  /**
   * Create a new branch. The current active branch continues from a base frame.
   *
   * @param {string} name - Human-readable branch name (e.g., "keyboard-shortcut")
   * @param {string} approach - What approach this branch will try
   * @param {number} baseFrameIndex - Frame index this branch starts from (checkpoint frame)
   * @returns {object} - The new branch object
   */
  createBranch(name, approach, baseFrameIndex = null) {
    const branchIndex = this.branches.length;
    const base = baseFrameIndex !== null ? baseFrameIndex : (this.nodes.length > 0 ? this.nodes.length - 1 : 0);
    const branch = {
      id: `branch-${branchIndex}-${name.replace(/[^a-z0-9]/gi, '-').slice(0, 30)}`,
      name,
      index: branchIndex,
      baseFrameIndex: base,
      startFrameIndex: this.nodes.length, // Next frame will be the first in this branch
      tipFrameIndex: this.nodes.length,
      status: 'exploring',
      approach,
      outcome: null,
      lesson: null,
    };
    this.branches.push(branch);
    this.activeBranchIndex = branchIndex;
    console.log(`[Trajectory] NEW BRANCH [${branch.id}]: "${approach}" (base: frame ${base})`);
    return branch;
  }

  /**
   * Close the current active branch.
   *
   * @param {string} status - 'succeeded' or 'failed'
   * @param {string} outcome - What happened (e.g., "clicked menu but it was hidden")
   * @param {string} lesson - What was learned (e.g., "menu is hidden behind window, use keyboard shortcut instead")
   */
  closeBranch(status, outcome, lesson) {
    const branch = this.branches[this.activeBranchIndex];
    if (!branch) return;
    branch.status = status;
    branch.outcome = outcome;
    branch.lesson = lesson;
    branch.tipFrameIndex = this.nodes.length > 0 ? this.nodes.length - 1 : 0;
    console.log(`[Trajectory] CLOSE BRANCH [${branch.id}]: ${status} - "${(lesson || '').slice(0, 80)}"`);
  }

  /**
   * Get failed branch lessons at a specific checkpoint (for injection into agent hints).
   * Returns lessons from all failed branches whose base frame is at or near the given checkpoint.
   *
   * @param {number} checkpointNodeIndex - The node index of the checkpoint
   * @returns {Array} - Array of { branchName, approach, lesson }
   */
  getFailedBranchLessons(checkpointNodeIndex = null) {
    return this.branches
      .filter(b => b.status === 'failed' && b.lesson)
      .filter(b => {
        if (checkpointNodeIndex === null) return true;
        // Show lessons from branches that share a similar base point (within 3 frames)
        return Math.abs(b.baseFrameIndex - checkpointNodeIndex) <= 3;
      })
      .map(b => ({
        branchName: b.name,
        approach: b.approach,
        lesson: b.lesson,
        frameRange: `frames ${b.startFrameIndex}-${b.tipFrameIndex}`,
      }));
  }

  /**
   * Auto-generate a branch name from the current context.
   * Uses the current step marker or the last action type.
   */
  _autoBranchName() {
    const branchNum = this.branches.length;
    const lastNode = this.nodes[this.nodes.length - 1];
    if (lastNode?.action?.type) {
      return `attempt-${branchNum}-${lastNode.action.type}`;
    }
    return `attempt-${branchNum}`;
  }

  /**
   * Auto-generate a lesson from a failed branch.
   * Combines the last checkpoint description + the failure type.
   */
  _autoLesson(failureType) {
    const branch = this.branches[this.activeBranchIndex];
    if (!branch) return failureType;

    const lastCheckpoint = this.getLastCheckpoint();
    const cpDesc = lastCheckpoint ? lastCheckpoint.description : 'initial state';

    // Collect recent actions in this branch
    const branchNodes = this.nodes.slice(branch.startFrameIndex, branch.tipFrameIndex + 1);
    const recentActions = branchNodes
      .filter(n => n.action?.raw)
      .slice(-3)
      .map(n => n.action.raw)
      .join(', ');

    return `After "${cpDesc}", tried [${recentActions || branch.approach}] but ${failureType}`;
  }

  /**
   * Compute surprise score between previous node's expectation and current observation.
   *
   * Algorithm: Keyword overlap (NOT an LLM call).
   *   1. Extract keywords from the expectation text (nouns, verbs, adjectives)
   *   2. Extract keywords from the action result + action description of current node
   *   3. Surprise = 1 - (overlap / expected_keywords)
   *
   * Score interpretation:
   *   0.0 = Perfect match (all expected keywords found in observation)
   *   0.5 = Half the expected keywords missing (threshold for surprise flag)
   *   1.0 = Complete surprise (no overlap at all)
   *
   * @param {object} currentNode - The node just added
   * @returns {object|null} - { score, expected, observed } or null if no expectation
   */
  _computeSurprise(currentNode) {
    if (currentNode.index < 1) return null;
    const prevNode = this.nodes[currentNode.index - 1];
    if (!prevNode.expectation) return null;

    const expectedText = prevNode.expectation.toLowerCase();
    const observedParts = [];

    // Build observed text from current node's action result and any text context
    if (currentNode.toolResult) {
      observedParts.push(String(currentNode.toolResult).toLowerCase());
    }
    if (currentNode.action) {
      const raw = currentNode.action.raw || JSON.stringify(currentNode.action);
      observedParts.push(raw.toLowerCase());
    }
    // Include flags as signal (loop/stagnation = something unexpected)
    if (currentNode.flags.includes('loop')) observedParts.push('loop detected same screen');
    if (currentNode.flags.includes('stagnation')) observedParts.push('stagnation no change');

    const observedText = observedParts.join(' ');

    // Extract keywords: split on non-alphanumeric, filter stopwords and short words
    const stopwords = new Set(['the','a','an','is','are','was','were','be','been','being',
      'have','has','had','do','does','did','will','would','could','should','may','might',
      'shall','can','to','of','in','for','on','with','at','by','from','as','into','through',
      'during','before','after','above','below','between','under','again','further','then',
      'once','here','there','when','where','why','how','all','each','every','both','few',
      'more','most','other','some','such','no','nor','not','only','own','same','so','than',
      'too','very','just','because','but','and','or','if','while','that','this','it','i',
      'you','he','she','we','they','me','him','her','us','them','my','your','his','its',
      'our','their','what','which','who','see','look','like','get','got','let','now']);

    const extractKeywords = (text) => {
      return text.split(/[^a-z0-9]+/)
        .filter(w => w.length > 2 && !stopwords.has(w));
    };

    const expectedKw = extractKeywords(expectedText);
    if (expectedKw.length === 0) return null;

    const observedKw = new Set(extractKeywords(observedText));

    // Count how many expected keywords appear in observed text
    let matches = 0;
    for (const kw of expectedKw) {
      if (observedKw.has(kw)) {
        matches++;
      } else {
        // Partial match: check if observed contains the keyword as substring
        for (const okw of observedKw) {
          if (okw.includes(kw) || kw.includes(okw)) {
            matches += 0.5;
            break;
          }
        }
      }
    }

    const score = 1 - (matches / expectedKw.length);

    return {
      score: Math.max(0, Math.min(1, score)),
      expected: prevNode.expectation,
      observed: observedText.slice(0, 200),
      expectedKeywords: expectedKw.length,
      matchedKeywords: matches,
    };
  }

  // ============================================================
  // CHECKPOINT SYSTEM (verified-good states for backtracking)
  // ============================================================

  /**
   * Mark the current state as a checkpoint (verified-good state).
   * The agent declares checkpoints after verifying a step succeeded.
   * These become safe return points for backtracking.
   */
  addCheckpoint(stepNumber, description) {
    const currentNode = this.nodes[this.nodes.length - 1];
    if (!currentNode) return;

    const checkpoint = {
      stepNumber,
      description,
      nodeId: currentNode.id,
      nodeIndex: currentNode.index,
      screenshotHash: currentNode.exactHash,
      semanticState: currentNode.semanticState || null,
      timestamp: Date.now(),
    };

    this.checkpoints.push(checkpoint);
    currentNode.flags.push('checkpoint');
    this.currentStep = stepNumber;
    this.consecutiveIssues = 0; // Reset on progress

    // Mark step as done in task plan
    if (this.taskPlan) {
      const planStep = this.taskPlan.steps.find(s => s.n === stepNumber);
      if (planStep) planStep.done = true;
    }

    console.log(`[Trajectory] CHECKPOINT [${stepNumber}]: ${description} (at ${currentNode.id}, issues reset)`);
  }

  /**
   * Store the agent's task plan (DAG of sub-goals).
   * @param {Array} steps - [{n: 1, desc: 'Open Safari'}, {n: 2, desc: 'Navigate to google'}]
   */
  setTaskPlan(steps) {
    this.taskPlan = {
      steps: steps.map(s => ({ n: s.n, desc: s.desc, done: false })),
      totalSteps: steps.length,
    };
    console.log(`[Trajectory] Task plan set: ${steps.length} steps`);
  }

  /**
   * Get the most recent checkpoint (nearest safe return point).
   */
  getLastCheckpoint() {
    return this.checkpoints.length > 0
      ? this.checkpoints[this.checkpoints.length - 1]
      : null;
  }

  /**
   * Compute recovery level using ADAPTIVE thresholds based on task progress.
   *
   * Derivation (Aristotle-style, from first principles):
   *
   * PREMISE 1: Recovery urgency is proportional to the RATE of failure, not absolute count.
   *   - 3 loops in 50 steps = 6% failure rate = mild concern (L1)
   *   - 3 loops in 5 steps = 60% failure rate = critical (L3)
   *   Proof: Absolute counts conflate long tasks with stuck tasks.
   *   A 50-step task with 3 loops early on (then recovered) should not stay at L2 forever.
   *
   * PREMISE 2: Recent failure density matters MORE than historical total.
   *   - 5 loops total but 0 in the last 10 steps = agent recovered. L0.
   *   - 2 loops total but both in the last 3 steps = agent is stuck NOW. L2+.
   *   Proof: Old issues that were resolved are not actionable intelligence.
   *
   * PREMISE 3: Consecutive failures without progress are the strongest signal.
   *   - consecutiveIssues resets on each checkpoint (progress = evidence of recovery).
   *   - Scale threshold to sqrt(totalNodes) to account for task complexity:
   *     Short task (9 nodes): sqrt(9)=3 consecutive -> L3
   *     Long task (100 nodes): sqrt(100)=10 consecutive -> L3
   *   Proof: Longer tasks naturally have more variance; requiring more evidence
   *   before aggressive recovery prevents false positives.
   *
   * PREMISE 4: Loops and stagnations have different severity.
   *   - Loop = agent returned to an IDENTICAL state = definitely stuck (weight 1.0)
   *   - Stagnation = action had no VISIBLE effect = might be intentional wait (weight 0.6)
   *   Proof: Some stagnations are legitimate (e.g., waiting for page load).
   *   Loops are never legitimate - they prove circular behavior.
   *   0.6 derived from observation: ~40% of stagnations resolve on next screenshot.
   *
   * LEVELS:
   *   L0: issueRate < 0.1 AND recentRate < 0.25 AND consecutiveIssues < sqrt(N)/3
   *   L1: issueRate >= 0.1 OR recentRate >= 0.25
   *   L2: issueRate >= 0.25 OR recentRate >= 0.5 OR consecutiveIssues >= sqrt(N)/2
   *   L3: recentRate >= 0.75 OR consecutiveIssues >= sqrt(N)
   */
  getRecoveryLevel() {
    const N = Math.max(this.nodes.length, 1);
    const sqrtN = Math.sqrt(N);

    // Weighted issue score (loops=1.0, surprises=0.8, stagnations=0.6)
    const weightedIssues = this.loopsDetected + this.surprisesDetected * 0.5 + this.stagnationsDetected * 0.4;
    const issueRate = weightedIssues / N;

    // Recent window: adaptive based on task size
    // Use max(3, floor(sqrt(N)*2)) - scales with task complexity
    const recentWindow = Math.max(3, Math.floor(sqrtN * 2));
    const recentNodes = this.nodes.slice(-recentWindow);
    const recentIssueCount = recentNodes.filter(n =>
      n.flags.includes('loop') || n.flags.includes('stagnation') || n.flags.includes('surprise')
    ).length;
    const recentRate = recentIssueCount / recentWindow;

    // Consecutive issues thresholds (scaled to sqrt of task size)
    const l3ConsecutiveThreshold = Math.max(3, Math.floor(sqrtN));
    const l2ConsecutiveThreshold = Math.max(2, Math.floor(sqrtN / 2));
    const l1ConsecutiveThreshold = Math.max(1, Math.floor(sqrtN / 3));

    // Level 3: Agent is deeply stuck (high recent density or long consecutive run)
    if (recentRate >= 0.75 || this.consecutiveIssues >= l3ConsecutiveThreshold) return 3;

    // Level 2: Agent is significantly struggling
    if (issueRate >= 0.35 || recentRate >= 0.6 || this.consecutiveIssues >= l2ConsecutiveThreshold) return 2;

    // Level 1: Some issues detected
    if (issueRate >= 0.1 || recentRate >= 0.25 || this.consecutiveIssues >= l1ConsecutiveThreshold) return 1;

    // Level 0: Normal operation
    return 0;
  }

  /**
   * Track consecutive issues (call when loop or stagnation detected).
   * Resets on checkpoint. Used for recovery level calculation.
   */
  trackIssue() {
    this.consecutiveIssues++;
  }

  // ============================================================
  // PERCEPTUAL HASHING
  // ============================================================

  _computeThumbnailHash(screenshotPath) {
    try {
      const thumbPath = screenshotPath + '.thumb.png';
      // Resize to 32x32 with macOS sips (zero dependencies)
      execSync(
        `sips -z 32 32 --setProperty format png "${screenshotPath}" --out "${thumbPath}" 2>/dev/null`,
        { stdio: 'pipe', timeout: 5000 }
      );
      if (fs.existsSync(thumbPath)) {
        const data = fs.readFileSync(thumbPath);
        const hash = crypto.createHash('md5').update(data).digest('hex');
        try { fs.unlinkSync(thumbPath); } catch (e) {}
        return hash;
      }
    } catch (e) {}
    return null;
  }

  // ============================================================
  // ACTION/RESULT SUMMARIZATION
  // ============================================================

  _summarizeAction(action) {
    if (!action) return null;
    if (typeof action === 'string') return action;

    // Handle Claude tool_use format
    if (action.type === 'tool_use') {
      const input = action.input || {};
      switch (action.name) {
        case 'computer':
          return {
            type: input.action,
            coordinates: input.coordinate,
            text: input.text,
            raw: `${input.action}${input.coordinate ? ` (${input.coordinate.join(',')})` : ''}${input.text ? `: "${input.text.slice(0, 50)}"` : ''}`,
          };
        case 'bash':
          return {
            type: 'bash',
            command: (input.command || '').slice(0, 100),
            raw: `bash: ${(input.command || '').slice(0, 80)}`,
          };
        default:
          return { type: action.name, raw: JSON.stringify(input).slice(0, 100) };
      }
    }

    return { type: 'unknown', raw: JSON.stringify(action).slice(0, 100) };
  }

  _summarizeResult(result) {
    if (!result) return null;
    if (typeof result === 'string') return result.slice(0, 200);
    if (result.output) return result.output.slice(0, 200);
    return JSON.stringify(result).slice(0, 200);
  }

  // ============================================================
  // TASK COMPLETION
  // ============================================================

  complete(success, finalText = '') {
    this.endTime = Date.now();
    this.success = success;
    this.finalText = finalText;
    // Close active branch based on task outcome
    const activeBranch = this.branches[this.activeBranchIndex];
    if (activeBranch && activeBranch.status === 'exploring') {
      activeBranch.status = success ? 'succeeded' : 'failed';
      activeBranch.outcome = success ? 'Task completed' : 'Task failed';
      activeBranch.tipFrameIndex = this.nodes.length > 0 ? this.nodes.length - 1 : 0;
    }
    this.save();
    return this.generateViewer();
  }

  // ============================================================
  // PERSISTENCE
  // ============================================================

  save() {
    const data = {
      taskId: this.taskId,
      taskDescription: this.taskDescription,
      startTime: this.startTime,
      endTime: this.endTime || Date.now(),
      duration: (this.endTime || Date.now()) - this.startTime,
      success: this.success,
      finalText: this.finalText,
      totalSteps: this.nodes.length,
      loopsDetected: this.loopsDetected,
      stagnationsDetected: this.stagnationsDetected,
      surprisesDetected: this.surprisesDetected,
      checkpoints: this.checkpoints,
      taskPlan: this.taskPlan,
      recoveryLevel: this.getRecoveryLevel(),
      nodes: this.nodes.map(n => ({
        ...n,
        // Store relative path for portability
        screenshotPath: n.screenshotPath ? path.basename(n.screenshotPath) : null,
      })),
      edges: this.edges,
      branches: this.branches,
      activeBranchIndex: this.activeBranchIndex,
    };

    const trajPath = path.join(this.screenshotDir, 'trajectory.json');
    fs.writeFileSync(trajPath, JSON.stringify(data, null, 2));
    return trajPath;
  }

  // ============================================================
  // SYSTEM PROMPT INJECTION (recovery-level-aware hints + learning context)
  // ============================================================

  /**
   * Generate context-aware recovery hints using graph-theoretic backjumping.
   *
   * Backtracking Strategy (Aristotle proof from CS theory):
   *
   * PREMISE: There are 3 well-known backtracking strategies in state-space search:
   *   1. Chronological Backtracking (CB): Always go to most recent decision point.
   *      - Simple but O(n) worst case. Wastes time undoing irrelevant decisions.
   *   2. Backjumping (BJ): Go to the most recent RELEVANT decision point.
   *      - Skips irrelevant states. Requires conflict analysis.
   *   3. Conflict-Directed Backjumping (CBJ): Maintain conflict set, jump to deepest
   *      variable in the conflict set. Optimal but requires explicit constraint propagation.
   *
   * CONCLUSION: For an LLM agent, the LLM IS the conflict analyzer. It can reason
   * about which checkpoint is relevant to the current failure. Therefore:
   *   - We expose ALL checkpoints (not just the last) = give BJ the full conflict set
   *   - We let the LLM choose which checkpoint to return to = LLM does conflict analysis
   *   - We order recovery actions by COST = greedy cost-optimal search
   *
   * Recovery Action Costs (derived from reversibility + time + state disruption):
   *   Cost 1 (Trivial):    Try different method for same action (no undo needed)
   *   Cost 2 (Cheap):      Escape to close dialog/menu, Cmd+Z to undo
   *   Cost 3 (Moderate):   Navigate back to a specific checkpoint state
   *   Cost 4 (Expensive):  Hide all apps + return to desktop + restart step
   *   Cost 5 (Very High):  Abandon current approach entirely, use bash/terminal fallback
   *
   * The agent should always try the CHEAPEST recovery first, escalating only on failure.
   * This is provably optimal under the assumption that cheaper actions have higher
   * probability of success per unit cost (reasonable for UI recovery).
   *
   * @param {string|null} learningContext - Optional learning context from learning.js
   * @param {boolean} enableTrajectoryQuery - Enable Phase 3 trajectory query (default: true)
   */
  getAgentHints(learningContext = null, enableTrajectoryQuery = true) {
    const level = this.getRecoveryLevel();
    const hints = [];

    // --- LEARNING CONTEXT (always inject if available, regardless of recovery level) ---
    // This is the Reflexion layer: past lessons, known skills, proven patterns.
    // Even at recovery level 0, the agent benefits from past experience.
    if (learningContext) {
      hints.push('===== LEARNED EXPERIENCE (from past tasks) =====');
      hints.push(learningContext);
      hints.push('');
    }

    // --- PHASE 3: SIMILAR TRAJECTORY HINTS ---
    if (enableTrajectoryQuery && this.taskDescription) {
      try {
        const similar = findSimilar(this.taskDescription, 3);
        if (similar.length > 0) {
          hints.push('===== SIMILAR PAST TRAJECTORIES =====');
          for (const sim of similar) {
            const status = sim.success ? 'SUCCESS' : 'FAILED';
            const durationSec = Math.round(sim.duration / 1000);
            hints.push(`[${status}] "${sim.taskDescription}" (${durationSec}s, ${sim.stepCount} steps, similarity: ${(sim.similarity * 100).toFixed(0)}%)`);
            if (sim.keyLessons.length > 0) {
              for (const lesson of sim.keyLessons.slice(0, 2)) {
                hints.push(`  - ${lesson}`);
              }
            }
          }
          hints.push('');
        }
      } catch (e) {
        // Query errors should not crash the agent
        console.error('[Trajectory] Failed to query similar trajectories:', e.message);
      }
    }

    // If no recovery needed and no learning context, return null (no hints)
    if (level === 0 && !learningContext && hints.length === 0) return null;

    // If no recovery needed but have learning context, return just that
    if (level === 0) return hints.join('\n');

    const lastNode = this.nodes[this.nodes.length - 1];

    // --- SITUATIONAL AWARENESS (always include at L1+) ---
    hints.push('===== SYSTEM RECOVERY CONTEXT =====');
    if (this.taskPlan) {
      const done = this.taskPlan.steps.filter(s => s.done).length;
      const total = this.taskPlan.totalSteps;
      const nextStep = this.taskPlan.steps.find(s => !s.done);
      const currentDesc = nextStep ? nextStep.desc : 'all steps done';
      hints.push(`PROGRESS: ${done}/${total} steps verified. Current target: step ${nextStep ? nextStep.n : '?'} ("${currentDesc}").`);
    }

    // Expose ALL checkpoints (not just last) for LLM-driven backjumping
    if (this.checkpoints.length > 0) {
      hints.push('VERIFIED CHECKPOINTS (safe states you can return to):');
      for (const cp of this.checkpoints) {
        const age = this.nodes.length - 1 - cp.nodeIndex;
        const scene = cp.semanticState ? ` -- SCENE: ${cp.semanticState}` : '';
        hints.push(`  Step ${cp.stepNumber}: "${cp.description}" (${age} actions ago)${scene}`);
      }
      hints.push('Choose which checkpoint to return to based on where the failure started.');
    }

    // --- FAILED BRANCH LESSONS (what didn't work and why) ---
    const allFailedLessons = this.getFailedBranchLessons();
    if (allFailedLessons.length > 0) {
      hints.push('');
      hints.push('FAILED APPROACHES (do NOT repeat these):');
      for (const fl of allFailedLessons.slice(-5)) { // Show last 5 max
        hints.push(`  Branch "${fl.branchName}": ${fl.lesson}`);
      }
      hints.push('Learn from these failures. Try a DIFFERENT approach.');
    }

    const issueRate = (this.loopsDetected + this.surprisesDetected * 0.8 + this.stagnationsDetected * 0.6) / Math.max(this.nodes.length, 1);
    hints.push(`ISSUE RATE: ${(issueRate * 100).toFixed(0)}% (${this.loopsDetected} loops, ${this.surprisesDetected} surprises, ${this.stagnationsDetected} stagnations in ${this.nodes.length} steps). Recovery level: ${level}/3.`);

    // --- SURPRISE CONTEXT (show recent surprises so agent can adjust expectations) ---
    const recentSurprises = this.nodes.slice(-10).filter(n => n.flags.includes('surprise'));
    if (recentSurprises.length > 0) {
      hints.push('');
      hints.push('RECENT SURPRISES (your expectation did not match what happened):');
      for (const sn of recentSurprises) {
        const s = sn.surprise;
        if (s) {
          hints.push(`  At ${sn.id}: Expected "${s.expected.slice(0, 60)}" but got surprise (score: ${s.score.toFixed(2)})`);
        }
      }
      hints.push('ADVICE: If you keep getting surprised, your mental model of the UI is wrong. Take a fresh screenshot and reassess before acting.');
    }

    // --- Level 1: Cost-ordered recovery (cheapest first) ---
    if (level >= 1) {
      hints.push('');
      hints.push('RECOVERY ACTIONS (ordered by cost - try cheapest first):');
      hints.push('  [Cost 1] Try a different method for the same goal (keyboard shortcut instead of click, or vice versa)');
      hints.push('  [Cost 2] Press Escape to dismiss dialogs/menus, then retry');
      if (level >= 2) {
        hints.push('  [Cost 2] Cmd+Z to undo recent actions, then try a different approach');
        hints.push('  [Cost 3] Navigate back to a checkpoint state using the NAVIGATION PLAN below');

        // Generate structured navigation plan for the nearest checkpoint
        if (this.checkpoints.length > 0) {
          const navPlan = this.computeNavigationPlan();
          if (navPlan.actions.length > 0) {
            hints.push('');
            hints.push(`NAVIGATION PLAN to return to Checkpoint ${navPlan.targetCheckpoint.stepNumber} ("${navPlan.targetCheckpoint.description}"):`);
            let stepNum = 1;
            for (const act of navPlan.actions) {
              if (act.action === 'screenshot') {
                hints.push(`  ${stepNum}. Take a screenshot to verify you're back at the checkpoint`);
              } else {
                const repeatStr = act.repeat > 1 ? ` ${act.repeat} times` : '';
                hints.push(`  ${stepNum}. Press ${act.text}${repeatStr} (${act.reason})`);
              }
              stepNum++;
            }
            if (navPlan.targetScene) {
              hints.push(`  Expected result: ${navPlan.targetScene}`);
            }
            if (navPlan.targetHash) {
              hints.push(`  (hash: ${navPlan.targetHash.slice(0, 8)}...)`);
            }
            for (const w of navPlan.warnings) {
              hints.push(`  WARNING: ${w}`);
            }
            hints.push(`  Estimated cost: ${navPlan.estimatedCost} (${navPlan.actionsSinceCheckpoint} actions to undo)`);
          }
        }
      }
      if (level >= 3) {
        hints.push('  [Cost 4] Cmd+H to hide all windows, click desktop, restart from a clean state');
        hints.push('  [Cost 5] Abandon GUI approach entirely - use a bash command to achieve the goal');
      }
    }

    // --- Level 3: Forced action ---
    if (level >= 3) {
      hints.push('');
      hints.push('CRITICAL: You have been stuck for a significant portion of this task.');
      hints.push('You MUST try a recovery action NOW. Do NOT repeat any previously failed action.');
      hints.push('Start with the cheapest recovery that you have NOT already tried.');
      if (this.checkpoints.length > 0) {
        hints.push('If GUI methods keep failing, consider: which checkpoint is BEFORE the point where things started going wrong? Go back to THAT one, not necessarily the most recent.');
      }
    }

    return hints.join('\n');
  }

  // ============================================================
  // HTML VIEWER GENERATION
  // ============================================================

  generateViewer() {
    const trajectory = {
      taskId: this.taskId,
      taskDescription: this.taskDescription,
      startTime: this.startTime,
      endTime: this.endTime || Date.now(),
      duration: (this.endTime || Date.now()) - this.startTime,
      success: this.success,
      finalText: this.finalText,
      totalSteps: this.nodes.length,
      loopsDetected: this.loopsDetected,
      stagnationsDetected: this.stagnationsDetected,
      surprisesDetected: this.surprisesDetected,
      branches: this.branches.length,
      failedBranches: this.branches.filter(b => b.status === 'failed').length,
    };

    // Generate thumbnail base64 for each node (small enough to embed)
    const nodesWithThumbs = this.nodes.map(node => {
      let thumbBase64 = '';
      if (node.screenshotPath && fs.existsSync(node.screenshotPath)) {
        try {
          // Create small thumbnail for embedding
          const thumbPath = node.screenshotPath + '.viewer.jpg';
          execSync(`sips -Z 400 --setProperty format jpeg --setProperty formatOptions 60 "${node.screenshotPath}" --out "${thumbPath}" 2>/dev/null`, { stdio: 'pipe', timeout: 5000 });
          if (fs.existsSync(thumbPath)) {
            thumbBase64 = fs.readFileSync(thumbPath).toString('base64');
            try { fs.unlinkSync(thumbPath); } catch (e) {}
          }
        } catch (e) {}
      }
      return {
        id: node.id,
        index: node.index,
        relativeTime: node.relativeTime,
        action: node.action,
        toolResult: node.toolResult,
        flags: node.flags,
        expectation: node.expectation,
        surprise: node.surprise,
        branch: node.branch,
        thumbBase64,
      };
    });

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Trajectory: ${this.taskDescription || this.taskId}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro', system-ui, sans-serif;
    background: #0a0a0f;
    color: #e0e0e0;
    min-height: 100vh;
  }

  .header {
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
    padding: 24px 32px;
    border-bottom: 1px solid #2a2a4a;
  }
  .header h1 { font-size: 20px; font-weight: 600; color: #fff; margin-bottom: 8px; }
  .header .desc { font-size: 14px; color: #888; margin-bottom: 16px; }

  .stats {
    display: flex; gap: 24px; flex-wrap: wrap;
  }
  .stat {
    background: rgba(255,255,255,0.05);
    border-radius: 8px;
    padding: 8px 16px;
    font-size: 13px;
  }
  .stat .label { color: #666; margin-right: 6px; }
  .stat .value { color: #fff; font-weight: 600; }
  .stat.success .value { color: #4ade80; }
  .stat.failure .value { color: #f87171; }
  .stat.warning .value { color: #fbbf24; }

  .timeline {
    padding: 32px;
    max-width: 900px;
    margin: 0 auto;
  }

  .node {
    position: relative;
    margin-bottom: 4px;
    padding-left: 40px;
  }
  .node::before {
    content: '';
    position: absolute;
    left: 15px;
    top: 0;
    bottom: 0;
    width: 2px;
    background: #2a2a4a;
  }
  .node:last-child::before { display: none; }

  .node-dot {
    position: absolute;
    left: 8px;
    top: 16px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #3b82f6;
    border: 2px solid #0a0a0f;
    z-index: 1;
  }
  .node.flag-loop .node-dot { background: #ef4444; box-shadow: 0 0 8px #ef4444; }
  .node.flag-stagnation .node-dot { background: #f59e0b; box-shadow: 0 0 8px #f59e0b; }
  .node.flag-checkpoint .node-dot { background: #22d3ee; box-shadow: 0 0 10px #22d3ee; width: 20px; height: 20px; left: 6px; }
  .node.flag-surprise .node-dot { background: #f97316; box-shadow: 0 0 8px #f97316; }
  .node.first .node-dot { background: #22c55e; }
  .node.last .node-dot { background: #a855f7; }

  .node-card {
    background: #13131f;
    border: 1px solid #2a2a4a;
    border-radius: 12px;
    padding: 16px;
    transition: border-color 0.2s;
  }
  .node-card:hover { border-color: #3b82f6; }
  .node.flag-loop .node-card { border-color: #ef4444; }
  .node.flag-stagnation .node-card { border-color: #f59e0b; }
  .node.flag-checkpoint .node-card { border-color: #22d3ee; background: rgba(34,211,238,0.03); }
  .node.flag-surprise .node-card { border-color: #f97316; background: rgba(249,115,22,0.03); }

  .node-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }
  .node-id { font-size: 12px; font-weight: 600; color: #3b82f6; }
  .node-time { font-size: 11px; color: #555; }

  .node-flags {
    display: flex; gap: 6px; margin-bottom: 8px;
  }
  .flag {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 2px 8px;
    border-radius: 4px;
  }
  .flag-loop-tag { background: rgba(239,68,68,0.2); color: #ef4444; }
  .flag-stagnation-tag { background: rgba(245,158,11,0.2); color: #f59e0b; }
  .flag-checkpoint-tag { background: rgba(34,211,238,0.2); color: #22d3ee; }
  .flag-surprise-tag { background: rgba(249,115,22,0.2); color: #f97316; }

  /* Branch color coding */
  .branch-tag {
    font-size: 9px;
    font-weight: 500;
    padding: 1px 6px;
    border-radius: 3px;
    background: rgba(139,92,246,0.15);
    color: #a78bfa;
    margin-left: 6px;
  }
  .branch-failed .node-card { border-left: 3px solid #ef4444; }
  .branch-succeeded .node-card { border-left: 3px solid #22c55e; }

  .node-action {
    font-size: 13px;
    color: #a0a0a0;
    margin-bottom: 10px;
    padding: 6px 10px;
    background: rgba(255,255,255,0.03);
    border-radius: 6px;
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
  }
  .action-type {
    color: #60a5fa;
    font-weight: 600;
  }

  .node-screenshot {
    cursor: pointer;
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid #2a2a4a;
    transition: transform 0.2s;
  }
  .node-screenshot:hover { transform: scale(1.02); }
  .node-screenshot img {
    width: 100%;
    display: block;
  }

  .edge-label {
    padding: 4px 0 4px 48px;
    font-size: 11px;
    color: #444;
  }
  .edge-label .arrow { color: #3b82f6; margin-right: 4px; }

  /* Full-screen screenshot overlay */
  .overlay {
    display: none;
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.9);
    z-index: 1000;
    cursor: pointer;
    align-items: center;
    justify-content: center;
  }
  .overlay.active { display: flex; }
  .overlay img { max-width: 95%; max-height: 95%; object-fit: contain; border-radius: 8px; }

  .empty { text-align: center; padding: 48px; color: #555; font-size: 14px; }
</style>
</head>
<body>

<div class="header">
  <h1>Agent Trajectory: ${this.taskDescription || this.taskId}</h1>
  <div class="desc">Task ID: ${this.taskId}</div>
  <div class="stats">
    <div class="stat ${trajectory.success === true ? 'success' : trajectory.success === false ? 'failure' : ''}">
      <span class="label">Status</span>
      <span class="value">${trajectory.success === true ? 'Success' : trajectory.success === false ? 'Failed' : 'In Progress'}</span>
    </div>
    <div class="stat">
      <span class="label">Steps</span>
      <span class="value">${trajectory.totalSteps}</span>
    </div>
    <div class="stat">
      <span class="label">Duration</span>
      <span class="value">${(trajectory.duration / 1000).toFixed(1)}s</span>
    </div>
    <div class="stat ${trajectory.loopsDetected > 0 ? 'warning' : ''}">
      <span class="label">Loops</span>
      <span class="value">${trajectory.loopsDetected}</span>
    </div>
    <div class="stat ${trajectory.stagnationsDetected > 0 ? 'warning' : ''}">
      <span class="label">Stagnations</span>
      <span class="value">${trajectory.stagnationsDetected}</span>
    </div>
    <div class="stat ${trajectory.surprisesDetected > 0 ? 'warning' : ''}">
      <span class="label">Surprises</span>
      <span class="value">${trajectory.surprisesDetected}</span>
    </div>
    <div class="stat">
      <span class="label">Branches</span>
      <span class="value">${trajectory.branches}</span>
    </div>
    <div class="stat ${trajectory.failedBranches > 0 ? 'failure' : ''}">
      <span class="label">Failed</span>
      <span class="value">${trajectory.failedBranches}</span>
    </div>
  </div>
</div>

<div class="timeline" id="timeline"></div>

<div class="overlay" id="overlay" onclick="this.classList.remove('active')">
  <img id="overlay-img" />
</div>

<script>
const nodes = ${JSON.stringify(nodesWithThumbs)};
const branches = ${JSON.stringify(this.branches)};
const branchStatusMap = {};
branches.forEach(b => { branchStatusMap[b.id] = b.status; });

const timeline = document.getElementById('timeline');

if (nodes.length === 0) {
  timeline.innerHTML = '<div class="empty">No steps recorded</div>';
} else {
  nodes.forEach((node, idx) => {
    const flags = node.flags || [];
    const isFirst = idx === 0;
    const isLast = idx === nodes.length - 1;

    let classes = 'node';
    if (isFirst) classes += ' first';
    if (isLast) classes += ' last';
    flags.forEach(f => classes += ' flag-' + f);
    if (node.branch && branchStatusMap[node.branch]) {
      classes += ' branch-' + branchStatusMap[node.branch];
    }

    let actionHtml = '';
    if (node.action) {
      const raw = node.action.raw || JSON.stringify(node.action);
      const type = node.action.type || 'action';
      actionHtml = '<div class="node-action"><span class="action-type">' + type + '</span> ' + escapeHtml(raw) + '</div>';
    }

    let flagsHtml = '';
    if (flags.length > 0) {
      flagsHtml = '<div class="node-flags">';
      flags.forEach(f => {
        flagsHtml += '<span class="flag flag-' + f + '-tag">' + f + '</span>';
      });
      flagsHtml += '</div>';
    }

    let expectHtml = '';
    if (node.expectation) {
      expectHtml = '<div class="node-action" style="border-left:3px solid #3b82f6;font-style:italic;color:#60a5fa;">EXPECT: ' + escapeHtml(node.expectation) + '</div>';
    }
    let surpriseHtml = '';
    if (node.surprise && node.surprise.score > 0.5) {
      surpriseHtml = '<div class="node-action" style="border-left:3px solid #f97316;color:#f97316;">SURPRISE (score: ' + node.surprise.score.toFixed(2) + '): Expected "' + escapeHtml(node.surprise.expected || '').slice(0, 80) + '"</div>';
    }

    let screenshotHtml = '';
    if (node.thumbBase64) {
      screenshotHtml = '<div class="node-screenshot" onclick="showFull(this)"><img src="data:image/jpeg;base64,' + node.thumbBase64 + '" /></div>';
    }

    const timeStr = (node.relativeTime / 1000).toFixed(1) + 's';
    const label = isFirst ? 'Initial State' : isLast ? 'Final State' : 'Step ' + node.index;

    const div = document.createElement('div');
    div.className = classes;
    div.innerHTML =
      '<div class="node-dot"></div>' +
      '<div class="node-card">' +
        '<div class="node-header">' +
          '<span class="node-id">' + label + (node.branch ? ' <span class="branch-tag">' + escapeHtml(node.branch) + '</span>' : '') + '</span>' +
          '<span class="node-time">+' + timeStr + '</span>' +
        '</div>' +
        flagsHtml +
        expectHtml +
        actionHtml +
        surpriseHtml +
        screenshotHtml +
      '</div>';
    timeline.appendChild(div);

    // Edge label between nodes
    if (!isLast && nodes[idx + 1]?.action) {
      const edgeDiv = document.createElement('div');
      edgeDiv.className = 'edge-label';
      const nextAction = nodes[idx + 1].action;
      edgeDiv.innerHTML = '<span class="arrow">&#x2193;</span>' + escapeHtml(nextAction.raw || '');
      timeline.appendChild(edgeDiv);
    }
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function showFull(el) {
  const img = el.querySelector('img');
  if (img) {
    document.getElementById('overlay-img').src = img.src;
    document.getElementById('overlay').classList.add('active');
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.getElementById('overlay').classList.remove('active');
  }
});
</script>

</body>
</html>`;

    const viewerPath = path.join(this.screenshotDir, 'viewer.html');
    fs.writeFileSync(viewerPath, html);
    console.log(`[Trajectory] Viewer saved: ${viewerPath}`);
    return viewerPath;
  }
  // ============================================================
  // NAVIGATION PLANNER (structured checkpoint recovery)
  // ============================================================

  /**
   * Compute a structured navigation plan to return to a target checkpoint.
   *
   * Analyzes actions between the checkpoint and current frame, then generates
   * an ordered list of compensating actions (cheapest first).
   *
   * Action classification:
   *   - type/key text input -> Cmd+Z to undo
   *   - key "cmd+n"/"cmd+t" (new window/tab) -> Cmd+W to close
   *   - key "cmd+space" (Spotlight) -> Escape to dismiss
   *   - left_click on menus/dialogs -> Escape to dismiss
   *   - bash commands -> may not be reversible (flag as warning)
   *   - screenshot -> no-op (observation only)
   *
   * @param {number} targetCheckpointIdx - Index into this.checkpoints[]
   * @returns {object} { actions: [...], estimatedCost: N, targetHash, targetScene, warnings }
   */
  computeNavigationPlan(targetCheckpointIdx = null) {
    // Default: use last checkpoint
    const cpIdx = targetCheckpointIdx !== null
      ? targetCheckpointIdx
      : this.checkpoints.length - 1;

    if (cpIdx < 0 || cpIdx >= this.checkpoints.length) {
      return { actions: [], estimatedCost: 0, targetHash: null, targetScene: null, warnings: ['No valid checkpoint to navigate to'] };
    }

    const checkpoint = this.checkpoints[cpIdx];
    const cpNodeIdx = checkpoint.nodeIndex;
    const currentIdx = this.nodes.length - 1;

    if (currentIdx <= cpNodeIdx) {
      return { actions: [], estimatedCost: 0, targetHash: checkpoint.screenshotHash, targetScene: checkpoint.semanticState, warnings: ['Already at or before checkpoint'] };
    }

    // Analyze actions between checkpoint and current frame
    const actionNodes = this.nodes.slice(cpNodeIdx + 1, currentIdx + 1).filter(n => n.action);

    // Classify actions and build compensating plan
    const plan = [];
    const warnings = [];
    let textInputCount = 0;
    let newWindowCount = 0;
    let newTabCount = 0;
    let dialogMenuCount = 0;
    let appOpened = false;
    let bashCommands = 0;

    for (const node of actionNodes) {
      const action = node.action;
      if (!action) continue;

      const actionType = action.type || '';
      const actionText = (action.text || '').toLowerCase();
      const actionRaw = (action.raw || '').toLowerCase();

      // Text input (type action)
      if (actionType === 'type') {
        textInputCount += Math.max(1, Math.ceil((action.text || '').length / 20)); // ~1 undo per 20 chars
      }
      // Keyboard shortcuts
      else if (actionType === 'key') {
        if (actionText.includes('cmd+n') || actionText.includes('cmd+shift+n')) {
          newWindowCount++;
        } else if (actionText.includes('cmd+t')) {
          newTabCount++;
        } else if (actionText.includes('cmd+space')) {
          dialogMenuCount++; // Spotlight = dialog-like
        } else if (actionText.includes('cmd+o')) {
          dialogMenuCount++; // Open dialog
        } else if (actionText === 'return' || actionText === 'enter') {
          // Return might confirm a dialog — ambiguous, skip
        } else if (actionText === 'tab') {
          // Tab navigation — harmless, skip
        }
        // General text input via key events (single chars)
        else if (actionText.length === 1 && !actionText.includes('cmd') && !actionText.includes('ctrl')) {
          textInputCount++;
        }
      }
      // Clicks — harder to reverse, might have opened menus
      else if (actionType === 'left_click' || actionType === 'right_click' || actionType === 'double_click') {
        // Clicks near top of screen (y < 30) = likely menu bar
        if (action.coordinates && action.coordinates[1] < 30) {
          dialogMenuCount++;
        }
        // Right-click = context menu
        if (actionType === 'right_click') {
          dialogMenuCount++;
        }
      }
      // Bash commands — often not reversible
      else if (actionType === 'bash') {
        bashCommands++;
        const cmd = (action.command || actionRaw || '').toLowerCase();
        if (cmd.includes('open ') || cmd.includes('open	')) {
          appOpened = true;
        }
      }
    }

    // Build compensating actions (cheapest first)
    let cost = 0;

    // 1. Escape presses (dismiss any open dialogs/menus/Spotlight)
    if (dialogMenuCount > 0) {
      const escCount = Math.min(dialogMenuCount, 3); // Cap at 3
      plan.push({
        action: 'key',
        text: 'Escape',
        repeat: escCount,
        reason: `Dismiss ${escCount} dialog(s)/menu(s) opened since checkpoint`,
        cost: 1,
      });
      cost += escCount;
    }

    // 2. Cmd+Z for text input (undo)
    if (textInputCount > 0) {
      const undoCount = Math.min(textInputCount, 10); // Cap at 10
      plan.push({
        action: 'key',
        text: 'cmd+z',
        repeat: undoCount,
        reason: `Undo ~${undoCount} text input action(s)`,
        cost: 2,
      });
      cost += undoCount * 2;
    }

    // 3. Cmd+W for new windows/tabs
    if (newWindowCount + newTabCount > 0) {
      const closeCount = newWindowCount + newTabCount;
      plan.push({
        action: 'key',
        text: 'cmd+w',
        repeat: Math.min(closeCount, 5), // Cap at 5
        reason: `Close ${closeCount} window(s)/tab(s) opened since checkpoint`,
        cost: 3,
      });
      cost += closeCount * 3;
    }

    // 4. App opened via bash — try Cmd+H to hide it
    if (appOpened) {
      plan.push({
        action: 'key',
        text: 'cmd+h',
        repeat: 1,
        reason: 'Hide app opened via bash command',
        cost: 3,
      });
      cost += 3;
    }

    // 5. If bash commands were run that may have side effects, warn
    if (bashCommands > 0) {
      warnings.push(`${bashCommands} bash command(s) were run — these may not be fully reversible. Take a screenshot to verify state.`);
    }

    // 6. If nothing specific to undo, add a generic safety sequence
    if (plan.length === 0 && actionNodes.length > 0) {
      plan.push({
        action: 'key',
        text: 'Escape',
        repeat: 2,
        reason: 'Safety: dismiss any hidden dialogs',
        cost: 1,
      });
      cost += 2;
    }

    // Always end with: take a screenshot to verify
    plan.push({
      action: 'screenshot',
      text: 'screenshot',
      repeat: 1,
      reason: 'Verify arrival at checkpoint state',
      cost: 0,
    });

    return {
      actions: plan,
      estimatedCost: cost,
      actionsSinceCheckpoint: actionNodes.length,
      targetCheckpoint: {
        stepNumber: checkpoint.stepNumber,
        description: checkpoint.description,
        nodeIndex: checkpoint.nodeIndex,
      },
      targetHash: checkpoint.screenshotHash || null,
      targetScene: checkpoint.semanticState || checkpoint.description,
      warnings,
    };
  }

  /**
   * Verify if current screenshot matches a target checkpoint.
   * Returns match confidence: 'exact', 'perceptual', or 'none'.
   */
  verifyNavigation(targetCheckpointIdx) {
    if (this.nodes.length === 0) return { match: 'none', reason: 'no frames' };

    const cpIdx = targetCheckpointIdx !== null ? targetCheckpointIdx : this.checkpoints.length - 1;
    if (cpIdx < 0 || cpIdx >= this.checkpoints.length) return { match: 'none', reason: 'invalid checkpoint' };

    const checkpoint = this.checkpoints[cpIdx];
    const currentNode = this.nodes[this.nodes.length - 1];

    // Exact hash match
    if (checkpoint.screenshotHash && currentNode.exactHash === checkpoint.screenshotHash) {
      return { match: 'exact', reason: 'Screenshot hash matches checkpoint exactly' };
    }

    // Perceptual hash match (thumbnail)
    const cpNode = this.nodes[checkpoint.nodeIndex];
    if (cpNode && cpNode.thumbnailHash && currentNode.thumbnailHash === cpNode.thumbnailHash) {
      return { match: 'perceptual', reason: 'Perceptual hash matches (visually similar)' };
    }

    return { match: 'none', reason: 'Screenshot does not match checkpoint' };
  }

  // ============================================================
  // SEMANTIC STATE (LLM-generated screen descriptions)
  // ============================================================

  /**
   * Set a semantic description for the current (most recent) frame.
   * Called when the agent outputs a SCENE: marker.
   * For non-SCENE frames, we auto-generate from action summary.
   *
   * @param {string} description - 1-sentence description of what's on screen
   */
  setSemanticState(description) {
    const currentNode = this.nodes[this.nodes.length - 1];
    if (!currentNode) return;
    currentNode.semanticState = description;
    console.log(`[Trajectory] SCENE at ${currentNode.id}: "${description.slice(0, 80)}"`);
  }

  /**
   * Auto-set semantic state from action summary for frames without explicit SCENE.
   * Called for every frame to ensure all frames have some semantic state.
   */
  _autoSemanticState(node) {
    if (node.semanticState) return; // Already set by SCENE marker

    // Priority 1: Use resolved AX target + app context (best auto-generated quality)
    if (node.resolvedTarget) {
      const target = node.resolvedTarget;
      const appSuffix = target.app ? ' in ' + target.app : '';
      const actionType = node.action?.type || 'Interacted with';
      let verb = 'Interacted with';
      if (actionType === 'left_click') verb = 'Clicked';
      else if (actionType === 'double_click') verb = 'Double-clicked';
      else if (actionType === 'right_click') verb = 'Right-clicked';
      node.semanticState = verb + " '" + target.label + "' (" + target.role + ")" + appSuffix;
      return;
    }

    // Priority 2: Use assistant's stated intent (second best)
    if (node.assistantIntent) {
      node.semanticState = node.assistantIntent;
      return;
    }

    // Priority 3: Build from action type + any available info
    if (node.action) {
      const actionType = node.action.type || 'unknown';
      const text = node.action.text || '';
      const coords = node.action.coordinates;

      if (actionType === 'key') {
        node.semanticState = 'Pressed key: ' + text;
      } else if (actionType === 'type') {
        node.semanticState = 'Typed: "' + text.slice(0, 50) + '"';
      } else if (actionType === 'left_click' && coords) {
        // Fallback: coordinates only (least useful, but better than nothing)
        node.semanticState = 'Clicked at (' + coords[0] + ', ' + coords[1] + ')';
      } else if (actionType === 'screenshot') {
        node.semanticState = 'Screenshot captured';
      } else {
        const raw = node.action.raw || actionType;
        node.semanticState = raw;
      }
      return;
    }

    node.semanticState = 'initial state (no action)';
  }

  // ============================================================
  // BISECT - Binary search for root cause frame
  // ============================================================

  /**
   * Binary search through frames to find where things went wrong.
   *
   * Given a known-good frame index and a known-bad frame index, performs
   * binary search using a judge function to identify the FIRST bad frame.
   * This is the frame whose ACTION caused the transition from good to bad.
   *
   * Time complexity: O(log n) judge calls for n frames.
   *
   * @param {number} goodIdx - Index of a known-good frame (default: 0)
   * @param {number} badIdx - Index of a known-bad frame (default: last)
   * @param {function} judgeFn - async (frame) => 'good' | 'bad'
   * @returns {Promise<object>} - { culpritIndex, culpritFrame, culpritAction, stepsChecked, log }
   */
  async bisect(goodIdx = 0, badIdx = null, judgeFn) {
    if (!judgeFn) throw new Error('judgeFn is required');
    if (this.nodes.length === 0) throw new Error('No frames to bisect');

    let lo = Math.max(0, goodIdx);
    let hi = badIdx !== null ? Math.min(badIdx, this.nodes.length - 1) : this.nodes.length - 1;

    if (lo >= hi) throw new Error(`Invalid range: good=${lo}, bad=${hi}`);

    const log = [];
    let stepsChecked = 0;

    log.push(`Bisecting frames [${lo}..${hi}] (${hi - lo + 1} frames, ~${Math.ceil(Math.log2(hi - lo + 1))} checks needed)`);

    // Verify boundaries: lo should be good, hi should be bad
    const loVerdict = await judgeFn(this.nodes[lo]);
    stepsChecked++;
    log.push(`Frame ${lo}: ${loVerdict} (boundary check)`);
    if (loVerdict !== 'good') {
      log.push(`WARNING: Start frame ${lo} is not good. The problem may precede this range.`);
      return {
        culpritIndex: lo,
        culpritFrame: this.nodes[lo],
        culpritAction: this.nodes[lo].action,
        stepsChecked,
        log,
        confidence: 'low',
        reason: 'Start frame already bad',
      };
    }

    const hiVerdict = await judgeFn(this.nodes[hi]);
    stepsChecked++;
    log.push(`Frame ${hi}: ${hiVerdict} (boundary check)`);
    if (hiVerdict !== 'bad') {
      log.push(`WARNING: End frame ${hi} is not bad. No regression found in this range.`);
      return {
        culpritIndex: null,
        culpritFrame: null,
        culpritAction: null,
        stepsChecked,
        log,
        confidence: 'none',
        reason: 'End frame is not bad - no regression in range',
      };
    }

    // Binary search: find first bad frame
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const verdict = await judgeFn(this.nodes[mid]);
      stepsChecked++;
      log.push(`Frame ${mid}: ${verdict}`);

      if (verdict === 'good') {
        lo = mid;
      } else {
        hi = mid;
      }
    }

    // hi is the first bad frame. The culprit ACTION is on frame hi
    // (the action that transitioned from the good state at lo to the bad state at hi)
    const culpritFrame = this.nodes[hi];
    const previousFrame = this.nodes[lo];

    log.push(`\nBISECT RESULT: Frame ${hi} is the first bad frame.`);
    log.push(`  Previous good: Frame ${lo} (action: ${previousFrame.action?.raw || 'none'})`);
    log.push(`  First bad:     Frame ${hi} (action: ${culpritFrame.action?.raw || 'none'})`);
    log.push(`  Steps checked: ${stepsChecked} (of ${this.nodes.length} total frames)`);

    return {
      culpritIndex: hi,
      culpritFrame: {
        id: culpritFrame.id,
        index: culpritFrame.index,
        action: culpritFrame.action,
        toolResult: culpritFrame.toolResult,
        flags: culpritFrame.flags,
        branch: culpritFrame.branch,
        screenshotPath: culpritFrame.screenshotPath,
      },
      culpritAction: culpritFrame.action,
      previousGoodFrame: {
        id: previousFrame.id,
        index: previousFrame.index,
        action: previousFrame.action,
        screenshotPath: previousFrame.screenshotPath,
      },
      stepsChecked,
      totalFrames: this.nodes.length,
      log,
      confidence: 'high',
    };
  }

}

// ============================================================
// LIST ALL TRAJECTORIES
// ============================================================
function listTrajectories() {
  if (!fs.existsSync(TRAJECTORY_DIR)) return [];
  return fs.readdirSync(TRAJECTORY_DIR)
    .filter(d => fs.existsSync(path.join(TRAJECTORY_DIR, d, 'trajectory.json')))
    .map(d => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(TRAJECTORY_DIR, d, 'trajectory.json'), 'utf8'));
        return {
          taskId: data.taskId,
          taskDescription: data.taskDescription,
          startTime: data.startTime,
          duration: data.duration,
          totalSteps: data.totalSteps,
          success: data.success,
          loopsDetected: data.loopsDetected,
          stagnationsDetected: data.stagnationsDetected,
          surprisesDetected: data.surprisesDetected || 0,
          branches: (data.branches || []).length,
          failedBranches: (data.branches || []).filter(b => b.status === 'failed').length,
        };
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.startTime - a.startTime);
}


// ============================================================
// LOAD TRAJECTORY FROM DISK (for bisect and post-hoc analysis)
// ============================================================

/**
 * Reconstruct a TrajectoryGraph from a saved trajectory.json file.
 * Used by bisect and other post-hoc analysis tools.
 *
 * @param {string} taskId - The task ID to load
 * @returns {TrajectoryGraph|null} - Reconstructed trajectory or null
 */
function loadTrajectory(taskId) {
  const trajPath = path.join(TRAJECTORY_DIR, taskId, 'trajectory.json');
  if (!fs.existsSync(trajPath)) return null;

  try {
    const data = JSON.parse(fs.readFileSync(trajPath, 'utf8'));
    const traj = new TrajectoryGraph(data.taskId, data.taskDescription);

    // Restore core state
    traj.startTime = data.startTime;
    traj.endTime = data.endTime;
    traj.success = data.success;
    traj.finalText = data.finalText || '';
    traj.loopsDetected = data.loopsDetected || 0;
    traj.stagnationsDetected = data.stagnationsDetected || 0;
    traj.surprisesDetected = data.surprisesDetected || 0;
    traj.checkpoints = data.checkpoints || [];
    traj.taskPlan = data.taskPlan || null;
    traj.branches = data.branches || [];
    traj.activeBranchIndex = data.activeBranchIndex || 0;

    // Restore nodes with full paths
    const screenshotDir = path.join(TRAJECTORY_DIR, taskId);
    traj.nodes = (data.nodes || []).map(n => ({
      ...n,
      screenshotPath: n.screenshotPath ? path.join(screenshotDir, n.screenshotPath) : null,
    }));
    traj.edges = data.edges || [];

    return traj;
  } catch (e) {
    console.error(`[Trajectory] Failed to load ${taskId}:`, e.message);
    return null;
  }
}

// ============================================================
// PHASE 3: CROSS-TASK QUERY INTERFACE
// ============================================================

// Lazy-load trajectory index
let trajectoryIndex = null;
function getIndex() {
  if (!trajectoryIndex) {
    trajectoryIndex = require('./trajectory-index.js');
  }
  return trajectoryIndex;
}

/**
 * Find trajectories similar to the given task description.
 * Returns ranked by keyword similarity (TF-IDF).
 *
 * @param {string} taskDescription - Task description to search for
 * @param {number} limit - Maximum number of results to return
 * @returns {Array<SimilarTrajectory>} - Similar trajectories with metadata
 */
function findSimilar(taskDescription, limit = 10) {
  try {
    const index = getIndex();
    const results = index.queryBySimilarity(taskDescription, limit);

    return results.map(r => {
      const traj = loadTrajectory(r.taskId);
      if (!traj) return null;

      // Extract key lessons from branches
      const keyLessons = traj.branches
        .filter(b => b.lesson)
        .map(b => b.lesson);

      return {
        taskId: r.taskId,
        similarity: r.similarity,
        success: r.metadata.success,
        duration: r.metadata.duration,
        stepCount: r.metadata.stepCount,
        keyLessons,
        taskDescription: r.metadata.taskDescription,
        startTime: r.metadata.startTime,
      };
    }).filter(Boolean);
  } catch (e) {
    console.error('[Trajectory] findSimilar error:', e.message);
    return [];
  }
}

/**
 * Get successful approaches for a given task type.
 * Task type is extracted from description (e.g., "open browser", "fill form").
 *
 * @param {string} taskType - Task type to filter by
 * @returns {Array<BranchLesson>} - Successful approaches
 */
function getSuccessfulApproaches(taskType) {
  try {
    const index = getIndex();
    const results = index.queryByTaskType(taskType);

    const lessons = [];
    for (const r of results) {
      const traj = loadTrajectory(r.taskId);
      if (!traj) continue;

      // Extract succeeded branches
      const successfulBranches = traj.branches.filter(b => b.status === 'succeeded');
      for (const branch of successfulBranches) {
        lessons.push({
          taskId: r.taskId,
          approach: branch.approach || 'unknown',
          checkpoints: traj.checkpoints.map(cp => cp.description),
          duration: r.metadata.duration,
          lesson: branch.lesson,
          timestamp: r.metadata.startTime,
        });
      }
    }

    return lessons;
  } catch (e) {
    console.error('[Trajectory] getSuccessfulApproaches error:', e.message);
    return [];
  }
}

/**
 * Get common failure patterns for a given task type.
 * Groups failed branches by similarity to identify recurring issues.
 *
 * @param {string} taskType - Task type to analyze
 * @returns {Array<FailurePattern>} - Common failure patterns
 */
function getFailurePatterns(taskType) {
  try {
    const index = getIndex();
    const results = index.queryByTaskType(taskType);

    // Collect all failed branches across trajectories
    const failures = [];
    for (const r of results) {
      const traj = loadTrajectory(r.taskId);
      if (!traj) continue;

      const failedBranches = traj.branches.filter(b => b.status === 'failed');
      for (const branch of failedBranches) {
        failures.push({
          taskId: r.taskId,
          lesson: branch.lesson || 'no lesson recorded',
          approach: branch.approach,
          outcome: branch.outcome,
          loopsDetected: traj.loopsDetected,
          stagnationsDetected: traj.stagnationsDetected,
        });
      }
    }

    // Group by lesson similarity (simple keyword clustering)
    const patterns = {};
    for (const failure of failures) {
      const key = _extractPatternKey(failure.lesson);
      if (!patterns[key]) {
        patterns[key] = {
          pattern: key,
          frequency: 0,
          taskIds: new Set(),
          recoveryUsed: [],
        };
      }
      patterns[key].frequency++;
      patterns[key].taskIds.add(failure.taskId);
      if (failure.outcome) {
        patterns[key].recoveryUsed.push(failure.outcome);
      }
    }

    // Convert to array and sort by frequency
    return Object.values(patterns)
      .map(p => ({
        pattern: p.pattern,
        frequency: p.frequency,
        taskIds: Array.from(p.taskIds),
        recoveryUsed: p.recoveryUsed[0] || 'none',
      }))
      .sort((a, b) => b.frequency - a.frequency);
  } catch (e) {
    console.error('[Trajectory] getFailurePatterns error:', e.message);
    return [];
  }
}

/**
 * Extract a pattern key from a failure lesson for grouping.
 * Uses first 3-4 keywords.
 */
function _extractPatternKey(lesson) {
  if (!lesson) return 'unknown';

  const words = lesson.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3)
    .slice(0, 4)
    .join(' ');

  return words || 'unknown';
}

module.exports = {
  TrajectoryGraph,
  listTrajectories,
  loadTrajectory,
  TRAJECTORY_DIR,
  // Phase 3: Query interface
  findSimilar,
  getSuccessfulApproaches,
  getFailurePatterns,
};
