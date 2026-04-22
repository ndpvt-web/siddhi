/**
 * cross-app-workflow.js - High-level cross-application workflow engine
 *
 * PURPOSE:
 *   Execute multi-step workflows that span multiple applications.
 *   Enables complex desktop automation like "copy from Safari, paste into Pages, email from Mail".
 *
 * ARCHITECTURE:
 *   - Workflow Definition: Structured format for multi-app task sequences
 *   - Step Execution: Execute each step with window switching and validation
 *   - Error Handling: Retry logic and graceful degradation
 *   - Trajectory Recording: Record workflow execution in trajectory graph
 *
 * WORKFLOW STEP FORMAT:
 *   {
 *     app: 'Safari',                      // Target application
 *     windowTitle: 'Google',              // Optional window specifier
 *     action: { type: 'click', ... },     // SemanticAction from Phase 2
 *     waitFor: 'AXSheet',                 // Optional: wait for element to appear
 *     timeout: 5000,                      // Step timeout in ms
 *     continueOnFailure: false            // Whether to continue if step fails
 *   }
 *
 * USAGE:
 *   const workflow = require('./cross-app-workflow');
 *   const steps = [
 *     { app: 'Safari', action: { type: 'click', target: {...} } },
 *     { app: 'Terminal', action: { type: 'type', text: 'ls' } }
 *   ];
 *   const result = await workflow.executeWorkflow({ name: 'dev-setup', steps });
 */

const coordinator = require('./multi-window-coordinator');
const semanticConverter = require('./semantic-action-converter');
const axGrounding = require('./ax-grounding');

// Configuration
const DEFAULT_STEP_TIMEOUT = 10000; // 10 seconds per step
const DEFAULT_WAIT_FOR_TIMEOUT = 5000; // 5 seconds to wait for element
const MAX_RETRY_ATTEMPTS = 2;
const RETRY_DELAY = 1000; // ms between retries

// Statistics
const stats = {
  workflowsExecuted: 0,
  workflowsSucceeded: 0,
  totalSteps: 0,
  failedSteps: 0,
  retries: 0,
};

// ============================================================================
// WORKFLOW DEFINITION AND VALIDATION
// ============================================================================

/**
 * Validate workflow definition structure.
 *
 * @param {object} workflow - Workflow to validate
 * @returns {object} - {valid: boolean, errors: string[]}
 */
function validateWorkflow(workflow) {
  const errors = [];

  if (!workflow) {
    errors.push('Workflow is null or undefined');
    return { valid: false, errors };
  }

  if (!workflow.name || typeof workflow.name !== 'string') {
    errors.push('Workflow must have a name');
  }

  if (!workflow.steps || !Array.isArray(workflow.steps) || workflow.steps.length === 0) {
    errors.push('Workflow must have non-empty steps array');
  } else {
    // Validate each step
    workflow.steps.forEach((step, i) => {
      if (!step.app || typeof step.app !== 'string') {
        errors.push(`Step ${i}: missing or invalid app name`);
      }

      if (!step.action || typeof step.action !== 'object') {
        errors.push(`Step ${i}: missing or invalid action`);
      }

      if (step.timeout && (typeof step.timeout !== 'number' || step.timeout <= 0)) {
        errors.push(`Step ${i}: invalid timeout (must be positive number)`);
      }
    });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Define a new workflow.
 * Returns workflow definition with metadata.
 *
 * @param {object} workflowSpec - Workflow specification {name, description, steps}
 * @returns {object} - Complete workflow definition
 */
function defineWorkflow(workflowSpec) {
  const validation = validateWorkflow(workflowSpec);
  if (!validation.valid) {
    throw new Error(`Invalid workflow: ${validation.errors.join(', ')}`);
  }

  // Extract unique apps from steps
  const apps = [...new Set(workflowSpec.steps.map(s => s.app))];

  return {
    name: workflowSpec.name,
    description: workflowSpec.description || '',
    steps: workflowSpec.steps,
    applications: apps,
    stepCount: workflowSpec.steps.length,
    createdAt: new Date().toISOString(),
    metadata: {
      estimatedDuration: estimateWorkflowDuration(workflowSpec.steps),
      requiresLaunch: workflowSpec.requiresLaunch || [],
      tags: workflowSpec.tags || [],
    },
  };
}

/**
 * Estimate workflow duration based on step types.
 *
 * @param {Array} steps - Workflow steps
 * @returns {number} - Estimated duration in ms
 */
function estimateWorkflowDuration(steps) {
  let duration = 0;

  for (const step of steps) {
    // Window switch: ~500ms
    duration += 500;

    // Action execution time by type
    if (step.action) {
      switch (step.action.type) {
        case 'click':
        case 'double_click':
          duration += 300;
          break;
        case 'type':
          duration += 500 + (step.action.text ? step.action.text.length * 50 : 0);
          break;
        case 'key':
          duration += 200;
          break;
        case 'launch':
          duration += 2000;
          break;
        default:
          duration += 500;
      }
    }

    // Wait time
    if (step.waitFor) {
      duration += step.timeout || DEFAULT_WAIT_FOR_TIMEOUT;
    }
  }

  return duration;
}

// ============================================================================
// WORKFLOW EXECUTION
// ============================================================================

/**
 * Execute a multi-step cross-application workflow.
 * Switches between apps, executes actions, validates outcomes.
 *
 * @param {object} workflow - Workflow definition
 * @param {object} options - {dryRun?, verbose?}
 * @returns {Promise<object>} - WorkflowResult
 */
async function executeWorkflow(workflow, options = {}) {
  const { dryRun = false, verbose = true } = options;

  const validation = validateWorkflow(workflow);
  if (!validation.valid) {
    throw new Error(`Invalid workflow: ${validation.errors.join(', ')}`);
  }

  stats.workflowsExecuted++;
  const startTime = Date.now();

  console.log(`[Workflow] Executing workflow "${workflow.name}" (${workflow.steps.length} steps)${dryRun ? ' [DRY RUN]' : ''}`);

  const stepResults = [];
  let currentApp = null;

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    const stepStartTime = Date.now();

    try {
      console.log(`[Workflow] Step ${i + 1}/${workflow.steps.length}: ${step.app} - ${step.action.type}`);

      if (dryRun) {
        // Dry run: validate without executing
        const validated = await validateStep(step);
        stepResults.push({
          step,
          success: validated.valid,
          duration: Date.now() - stepStartTime,
          dryRun: true,
          validation: validated,
        });
        continue;
      }

      // Real execution
      const result = await executeStep(step, { currentApp, verbose });

      stepResults.push({
        step,
        success: result.success,
        duration: Date.now() - stepStartTime,
        coordinates: result.coordinates,
        error: result.error,
      });

      stats.totalSteps++;

      if (!result.success) {
        stats.failedSteps++;
        console.error(`[Workflow] Step ${i + 1} failed: ${result.error}`);

        if (!step.continueOnFailure) {
          console.log('[Workflow] Stopping workflow due to step failure');
          break;
        }
      }

      currentApp = step.app;

    } catch (error) {
      console.error(`[Workflow] Step ${i + 1} exception:`, error.message);
      stats.failedSteps++;

      stepResults.push({
        step,
        success: false,
        duration: Date.now() - stepStartTime,
        error: error.message,
      });

      if (!step.continueOnFailure) {
        break;
      }
    }
  }

  const duration = Date.now() - startTime;
  const successCount = stepResults.filter(r => r.success).length;
  const workflowSuccess = successCount === workflow.steps.length;

  if (workflowSuccess) {
    stats.workflowsSucceeded++;
  }

  console.log(`[Workflow] Workflow "${workflow.name}" ${workflowSuccess ? 'SUCCEEDED' : 'FAILED'}: ${successCount}/${workflow.steps.length} steps in ${duration}ms`);

  return {
    success: workflowSuccess,
    name: workflow.name,
    stepsExecuted: successCount,
    stepsTotal: workflow.steps.length,
    stepResults,
    duration,
    trajectoryId: null, // TODO: integrate with trajectory.js
  };
}

/**
 * Validate a single workflow step.
 * Checks if app is running, action is valid, etc.
 *
 * @param {object} step - Workflow step
 * @returns {Promise<object>} - {valid: boolean, errors: string[]}
 */
async function validateStep(step) {
  const errors = [];

  // Check if app is running
  const isRunning = await coordinator.isAppRunning(step.app);
  if (!isRunning) {
    errors.push(`Application ${step.app} is not running`);
  }

  // Validate semantic action
  if (step.action && semanticConverter.isSemanticAction(step.action)) {
    const actionValidation = semanticConverter.validateSemanticAction(step.action);
    if (!actionValidation.valid) {
      errors.push(...actionValidation.errors);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Execute a single workflow step.
 *
 * @param {object} step - Workflow step
 * @param {object} context - Execution context {currentApp?, verbose?}
 * @returns {Promise<object>} - StepResult {success, coordinates?, error?}
 */
async function executeStep(step, context = {}) {
  const { currentApp, verbose = true } = context;
  const timeout = step.timeout || DEFAULT_STEP_TIMEOUT;

  // Switch to target app if needed
  if (currentApp !== step.app) {
    const switchResult = await coordinator.switchToWindow({
      appName: step.app,
      title: step.windowTitle,
    });

    if (!switchResult.success) {
      return {
        success: false,
        error: `Failed to switch to ${step.app}: ${switchResult.error}`,
      };
    }
  }

  // Execute action based on type
  const action = step.action;

  if (action.type === 'launch') {
    // Launch application
    const launchResult = await coordinator.launchApp(step.app);
    return {
      success: launchResult.success,
      error: launchResult.error,
    };
  }

  if (action.type === 'focus') {
    // Just focus the window (already done above)
    return { success: true };
  }

  if (action.type === 'arrange') {
    // Set window geometry
    if (!action.geometry) {
      return { success: false, error: 'arrange action requires geometry' };
    }

    try {
      await setWindowGeometry(
        { appName: step.app, title: step.windowTitle },
        action.geometry
      );
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // For semantic actions, resolve to coordinates and execute
  if (semanticConverter.isSemanticAction(action)) {
    try {
      const coords = await semanticConverter.semanticToCoordinate(action);

      if (!coords) {
        return {
          success: false,
          error: `Cannot resolve semantic target: ${semanticConverter.getSemanticDescription(action)}`,
        };
      }

      // Execute the action
      await executeAction(action, coords);

      // Wait for expected outcome if specified
      if (step.waitFor) {
        const waitResult = await waitForElement(step.waitFor, step.timeout || DEFAULT_WAIT_FOR_TIMEOUT);
        if (!waitResult.found) {
          return {
            success: false,
            error: `Expected outcome "${step.waitFor}" not found after ${waitResult.waited}ms`,
          };
        }
      }

      return {
        success: true,
        coordinates: coords,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  // Unsupported action type
  return {
    success: false,
    error: `Unsupported action type: ${action.type}`,
  };
}

/**
 * Execute action at coordinates.
 * Helper for executeStep.
 *
 * @param {object} action - SemanticAction
 * @param {object} coords - {x, y}
 */
async function executeAction(action, coords) {
  const { execSync } = require('child_process');

  switch (action.type) {
    case 'click':
      execSync(`cliclick c:${coords.x},${coords.y}`, { timeout: 3000 });
      await sleep(200);
      axGrounding.invalidateCache();
      break;

    case 'double_click':
      execSync(`cliclick dc:${coords.x},${coords.y}`, { timeout: 3000 });
      await sleep(300);
      axGrounding.invalidateCache();
      break;

    case 'type':
      if (action.text) {
        execSync(`cliclick c:${coords.x},${coords.y}`, { timeout: 3000 });
        await sleep(100);
        const escaped = action.text.replace(/'/g, "'\\''");
        execSync(`osascript -e 'tell application "System Events" to keystroke "${escaped}"'`, { timeout: 5000 });
        await sleep(100);
        axGrounding.invalidateCache();
      }
      break;

    case 'key':
      if (action.key) {
        execSync(`cliclick kp:${action.key}`, { timeout: 3000 });
        await sleep(100);
        axGrounding.invalidateCache();
      }
      break;

    default:
      throw new Error(`Unsupported action type: ${action.type}`);
  }
}

/**
 * Wait for element to appear in AX tree.
 * Polls AX tree until element with specified role appears.
 *
 * @param {string} roleOrLabel - AX role or label to wait for
 * @param {number} timeout - Timeout in ms
 * @returns {Promise<object>} - {found: boolean, waited: number, element?}
 */
async function waitForElement(roleOrLabel, timeout) {
  const startTime = Date.now();
  const pollInterval = 200; // Poll every 200ms

  while (Date.now() - startTime < timeout) {
    const axTree = await axGrounding.queryAXTree();

    const found = axTree.find(el =>
      el.role === roleOrLabel ||
      (el.label && el.label.includes(roleOrLabel))
    );

    if (found) {
      const waited = Date.now() - startTime;
      console.log(`[Workflow] Found "${roleOrLabel}" after ${waited}ms`);
      return {
        found: true,
        waited,
        element: found,
      };
    }

    await sleep(pollInterval);
  }

  const waited = Date.now() - startTime;
  console.warn(`[Workflow] Element "${roleOrLabel}" not found after ${waited}ms`);

  return {
    found: false,
    waited,
  };
}

/**
 * Helper for window geometry setting.
 */
async function setWindowGeometry(windowSpec, geometry) {
  const { appName, title, windowIndex } = windowSpec;
  const { x, y, width, height } = geometry;

  const jxaScript = `
    const se = Application("System Events");
    const proc = se.applicationProcesses["${appName}"];

    if (!proc.exists()) {
      throw new Error("Application not found");
    }

    let targetWindow = null;
    ${title ? `
    const windows = proc.windows();
    for (let i = 0; i < windows.length; i++) {
      if (windows[i].title && windows[i].title().includes("${title}")) {
        targetWindow = windows[i];
        break;
      }
    }
    ` : windowIndex !== undefined ? `
    const windows = proc.windows();
    if (windows.length > ${windowIndex}) {
      targetWindow = windows[${windowIndex}];
    }
    ` : `
    targetWindow = proc.windows[0];
    `}

    if (!targetWindow) {
      throw new Error("Window not found");
    }

    targetWindow.position = [${x}, ${y}];
    targetWindow.size = [${width}, ${height}];

    return "ok";
  `;

  const { execSync } = require('child_process');
  execSync(`osascript -l JavaScript -e '${jxaScript.replace(/'/g, "'\\''")}'`, {
    encoding: 'utf8',
    timeout: 5000,
  });
}

// ============================================================================
// HIGH-LEVEL WORKFLOW OPERATIONS
// ============================================================================

/**
 * Copy data from one app to another.
 * High-level operation that handles window switching and clipboard.
 *
 * @param {object} sourceSpec - {app, windowTitle?, element?}
 * @param {object} targetSpec - {app, windowTitle?, element?}
 * @param {object} options - {selectAll?, pasteAction?}
 * @returns {Promise<object>} - OperationResult
 */
async function copyBetweenApps(sourceSpec, targetSpec, options = {}) {
  console.log(`[Workflow] Copying from ${sourceSpec.app} to ${targetSpec.app}`);

  const sourceWindow = {
    appName: sourceSpec.app,
    title: sourceSpec.windowTitle,
  };

  const targetWindow = {
    appName: targetSpec.app,
    title: targetSpec.windowTitle,
  };

  const copyOptions = {
    sourceElement: sourceSpec.element,
    targetElement: targetSpec.element,
  };

  return coordinator.crossWindowOperation(sourceWindow, targetWindow, 'copy-paste', copyOptions);
}

/**
 * Drag element from one app to another.
 * Note: This requires both windows to be visible simultaneously.
 *
 * @param {object} sourceSpec - {app, windowTitle?, element}
 * @param {object} targetSpec - {app, windowTitle?, location}
 * @returns {Promise<object>} - OperationResult
 */
async function dragBetweenApps(sourceSpec, targetSpec) {
  if (!sourceSpec.element || !targetSpec.location) {
    throw new Error('[Workflow] dragBetweenApps requires sourceSpec.element and targetSpec.location');
  }

  console.log(`[Workflow] Dragging from ${sourceSpec.app} to ${targetSpec.app}`);

  const sourceWindow = {
    appName: sourceSpec.app,
    title: sourceSpec.windowTitle,
  };

  const targetWindow = {
    appName: targetSpec.app,
    title: targetSpec.windowTitle,
  };

  const dragOptions = {
    sourceElement: sourceSpec.element,
    targetLocation: targetSpec.location,
  };

  return coordinator.crossWindowOperation(sourceWindow, targetWindow, 'drag-drop', dragOptions);
}

/**
 * Execute workflow with retry logic.
 * Retries failed steps up to MAX_RETRY_ATTEMPTS.
 *
 * @param {object} workflow - Workflow definition
 * @param {object} options - {maxRetries?, verbose?}
 * @returns {Promise<object>} - WorkflowResult
 */
async function executeWorkflowWithRetry(workflow, options = {}) {
  const { maxRetries = MAX_RETRY_ATTEMPTS, verbose = true } = options;

  let lastResult = null;
  let attempt = 0;

  while (attempt <= maxRetries) {
    if (attempt > 0) {
      console.log(`[Workflow] Retry attempt ${attempt}/${maxRetries} for "${workflow.name}"`);
      stats.retries++;
      await sleep(RETRY_DELAY);
    }

    lastResult = await executeWorkflow(workflow, { verbose });

    if (lastResult.success) {
      return lastResult;
    }

    attempt++;
  }

  console.error(`[Workflow] Workflow "${workflow.name}" failed after ${maxRetries} retries`);

  return lastResult;
}

/**
 * Execute multiple workflows in sequence.
 * Useful for complex multi-stage operations.
 *
 * @param {Array} workflows - Array of workflow definitions
 * @param {object} options - {stopOnFailure?, verbose?}
 * @returns {Promise<object>} - BatchResult {success, workflowResults}
 */
async function executeWorkflowBatch(workflows, options = {}) {
  const { stopOnFailure = true, verbose = true } = options;

  console.log(`[Workflow] Executing ${workflows.length} workflows in sequence`);

  const results = [];

  for (let i = 0; i < workflows.length; i++) {
    const workflow = workflows[i];
    console.log(`[Workflow] Batch ${i + 1}/${workflows.length}: "${workflow.name}"`);

    const result = await executeWorkflow(workflow, { verbose });
    results.push(result);

    if (!result.success && stopOnFailure) {
      console.error(`[Workflow] Batch stopped at workflow ${i + 1} due to failure`);
      break;
    }
  }

  const successCount = results.filter(r => r.success).length;

  return {
    success: successCount === workflows.length,
    workflowsExecuted: results.length,
    workflowsTotal: workflows.length,
    workflowsSucceeded: successCount,
    results,
  };
}

// ============================================================================
// PRE-BUILT WORKFLOW TEMPLATES
// ============================================================================

/**
 * Create a simple two-app copy workflow.
 * Template for common copy-paste operations.
 *
 * @param {string} sourceApp - Source application
 * @param {string} targetApp - Target application
 * @param {object} sourceElement - Source element semantic target
 * @param {object} targetElement - Target element semantic target
 * @returns {object} - Workflow definition
 */
function createCopyWorkflow(sourceApp, targetApp, sourceElement, targetElement) {
  return defineWorkflow({
    name: `copy-${sourceApp}-to-${targetApp}`,
    description: `Copy from ${sourceApp} and paste into ${targetApp}`,
    steps: [
      {
        app: sourceApp,
        action: {
          type: 'click',
          target: sourceElement,
        },
        continueOnFailure: false,
      },
      {
        app: sourceApp,
        action: {
          type: 'key',
          key: 'cmd-c',
        },
        continueOnFailure: false,
      },
      {
        app: targetApp,
        action: {
          type: 'click',
          target: targetElement,
        },
        continueOnFailure: false,
      },
      {
        app: targetApp,
        action: {
          type: 'key',
          key: 'cmd-v',
        },
        continueOnFailure: false,
      },
    ],
  });
}

/**
 * Create a dev environment setup workflow.
 * Opens and arranges editor, terminal, and browser.
 *
 * @param {object} apps - {editor, terminal, browser} app names
 * @returns {object} - Workflow definition
 */
function createDevSetupWorkflow(apps) {
  const { editor = 'Visual Studio Code', terminal = 'Terminal', browser = 'Safari' } = apps;

  return defineWorkflow({
    name: 'dev-environment-setup',
    description: 'Set up development environment with editor, terminal, and browser',
    steps: [
      {
        app: editor,
        action: { type: 'launch' },
        continueOnFailure: false,
      },
      {
        app: terminal,
        action: { type: 'launch' },
        continueOnFailure: false,
      },
      {
        app: browser,
        action: { type: 'launch' },
        continueOnFailure: false,
      },
      // Arrange in split layout (editor left, terminal and browser right)
      {
        app: editor,
        action: {
          type: 'arrange',
          geometry: { x: 0, y: 0, w: 1200, h: 1080 },
        },
        continueOnFailure: true,
      },
      {
        app: terminal,
        action: {
          type: 'arrange',
          geometry: { x: 1200, y: 540, w: 720, h: 540 },
        },
        continueOnFailure: true,
      },
      {
        app: browser,
        action: {
          type: 'arrange',
          geometry: { x: 1200, y: 0, w: 720, h: 540 },
        },
        continueOnFailure: true,
      },
    ],
    requiresLaunch: [editor, terminal, browser],
    tags: ['development', 'setup', 'multi-window'],
  });
}

// ============================================================================
// WORKFLOW PERSISTENCE
// ============================================================================

/**
 * Save workflow definition to file.
 *
 * @param {object} workflow - Workflow definition
 * @param {string} filePath - Path to save to
 */
function saveWorkflowToFile(workflow, filePath) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, JSON.stringify(workflow, null, 2), 'utf8');
    console.log(`[Workflow] Saved workflow "${workflow.name}" to ${filePath}`);
  } catch (error) {
    console.error('[Workflow] saveWorkflowToFile error:', error.message);
    throw error;
  }
}

/**
 * Load workflow definition from file.
 *
 * @param {string} filePath - Path to load from
 * @returns {object|null} - Workflow definition or null
 */
function loadWorkflowFromFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      console.warn(`[Workflow] File not found: ${filePath}`);
      return null;
    }

    const data = fs.readFileSync(filePath, 'utf8');
    const workflow = JSON.parse(data);

    console.log(`[Workflow] Loaded workflow "${workflow.name}" from ${filePath}`);
    return workflow;
  } catch (error) {
    console.error('[Workflow] loadWorkflowFromFile error:', error.message);
    return null;
  }
}

// ============================================================================
// WORKFLOW ANALYSIS
// ============================================================================

/**
 * Analyze workflow to identify potential issues.
 * Checks for missing apps, invalid actions, etc.
 *
 * @param {object} workflow - Workflow to analyze
 * @returns {Promise<object>} - Analysis result {issues, warnings, info}
 */
async function analyzeWorkflow(workflow) {
  const issues = [];
  const warnings = [];
  const info = [];

  // Validate structure
  const validation = validateWorkflow(workflow);
  if (!validation.valid) {
    issues.push(...validation.errors);
  }

  // Check if apps are running
  const apps = [...new Set(workflow.steps.map(s => s.app))];
  for (const app of apps) {
    const isRunning = await coordinator.isAppRunning(app);
    if (!isRunning) {
      warnings.push(`Application ${app} is not currently running`);
    } else {
      info.push(`Application ${app} is running`);
    }
  }

  // Check for long workflows
  if (workflow.steps.length > 10) {
    warnings.push(`Workflow has ${workflow.steps.length} steps (may be fragile)`);
  }

  // Check for missing continueOnFailure flags
  const criticalSteps = workflow.steps.filter(s => !s.continueOnFailure);
  if (criticalSteps.length === workflow.steps.length) {
    info.push('All steps are critical (continueOnFailure=false)');
  }

  return {
    valid: issues.length === 0,
    issues,
    warnings,
    info,
  };
}

/**
 * Get workflow statistics.
 *
 * @returns {object} - Statistics
 */
function getWorkflowStats() {
  return {
    workflowsExecuted: stats.workflowsExecuted,
    workflowsSucceeded: stats.workflowsSucceeded,
    successRate: stats.workflowsExecuted > 0
      ? Math.round((stats.workflowsSucceeded / stats.workflowsExecuted) * 100)
      : 0,
    totalSteps: stats.totalSteps,
    failedSteps: stats.failedSteps,
    stepSuccessRate: stats.totalSteps > 0
      ? Math.round(((stats.totalSteps - stats.failedSteps) / stats.totalSteps) * 100)
      : 0,
    retries: stats.retries,
  };
}

// ============================================================================
// UTILITIES
// ============================================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Workflow definition
  defineWorkflow,
  validateWorkflow,

  // Workflow execution
  executeWorkflow,
  executeWorkflowWithRetry,
  executeWorkflowBatch,

  // High-level operations
  copyBetweenApps,
  dragBetweenApps,

  // Workflow templates
  createCopyWorkflow,
  createDevSetupWorkflow,

  // Workflow persistence
  saveWorkflowToFile,
  loadWorkflowFromFile,

  // Analysis
  analyzeWorkflow,
  getWorkflowStats,
};
