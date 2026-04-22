/**
 * Brain Multi-Agent Orchestration Module - Sub-Agent Spawning for Jarvis
 *
 * Extends the single-agent BrainOrchestrator into a multi-agent system:
 * - Specialized sub-agents: researcher, coder, reviewer, planner
 * - Each gets their own system prompt, tool subset, and model tier
 * - Cost-optimized: Haiku for 80%, Sonnet for 15%, Opus for 5%
 * - Parallel + sequential execution patterns
 * - Context isolation (sub-agents don't pollute each other)
 * - CrewAI-inspired delegation-via-tools pattern
 *
 * Research basis: CrewAI (delegation tools), AutoGen (handoff messages),
 * MagenticOne (ledger-based planning), LangGraph (agent-as-tool).
 *
 * Axioms:
 * - Uses same AI Gateway Bedrock endpoint as brain.js
 * - Sub-agents are lightweight: just different system prompts + tool subsets
 * - Each sub-agent call is a single runAgentLoop invocation (no new processes)
 * - Cost control: sub-agents default to cheapest viable model
 * - Results aggregated by orchestrator, not by sub-agents themselves
 *
 * @module brain-agents
 */

const https = require('https');
const crypto = require('crypto');

// ============================================================================
// CONFIGURATION
// ============================================================================

const AI_GATEWAY_HOST = 'ai-gateway.happycapy.ai';
const AI_GATEWAY_KEY = process.env.AI_GATEWAY_API_KEY || 'cc00f875633a4dca884e24f5ab6e0106';

const BEDROCK_PATHS = {
  'claude-opus-4-6': '/api/v1/bedrock/model/claude-opus-4-6/invoke',
  'claude-sonnet-4-6': '/api/v1/bedrock/model/claude-sonnet-4-6/invoke',
  'claude-haiku-4-5': '/api/v1/bedrock/model/claude-haiku-4-5/invoke',
};

const PRICING = {
  'claude-opus-4-6': { input: 5.00, output: 25.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'claude-haiku-4-5': { input: 1.00, output: 5.00 },
};

const MAX_SUB_AGENT_ITERATIONS = 10;
const SUB_AGENT_TIMEOUT = 60000; // 1 minute per sub-agent

// ============================================================================
// AGENT PROFILES
// ============================================================================

/**
 * Predefined agent profiles with optimized system prompts,
 * tool subsets, and model selections.
 */
const AGENT_PROFILES = {
  researcher: {
    name: 'Researcher',
    model: 'claude-haiku-4-5',
    max_iterations: 5,
    system_prompt: `You are a focused research agent. Your job is to find information efficiently.
- Search memories and the web for relevant information
- Read files when needed for context
- Summarize findings concisely
- Do NOT write code or make changes
- Do NOT use tools you don't need
- Return a clear, structured answer`,
    tools: ['memory_search', 'web_search', 'file_read', 'file_list', 'browser_navigate', 'browser_screenshot'],
  },

  coder: {
    name: 'Coder',
    model: 'claude-sonnet-4-6',
    max_iterations: 10,
    system_prompt: `You are a focused coding agent. Your job is to write and modify code efficiently.
- Write clean, correct code
- Use terminal for running commands and testing
- Write files using file_write
- Read existing code before modifying
- Test your changes when possible
- Return a summary of what you did`,
    tools: ['terminal_exec', 'file_read', 'file_write', 'file_list', 'xcode_build', 'xcode_deploy', 'xcode_create_project'],
  },

  reviewer: {
    name: 'Reviewer',
    model: 'claude-haiku-4-5',
    max_iterations: 5,
    system_prompt: `You are a code review agent. Your job is to review code for quality and correctness.
- Read the specified files carefully
- Check for bugs, security issues, edge cases
- Verify logic and data flow
- Suggest specific improvements
- Rate overall quality (1-10)
- Do NOT modify any files`,
    tools: ['file_read', 'file_list', 'memory_search'],
  },

  planner: {
    name: 'Planner',
    model: 'claude-sonnet-4-6',
    max_iterations: 3,
    system_prompt: `You are a task planning agent. Your job is to decompose complex tasks into sub-tasks.
- Analyze the task requirements
- Search memory for relevant context
- Break down into 2-5 concrete sub-tasks
- For each sub-task: specify agent type (researcher/coder/reviewer), input, and expected output
- Order sub-tasks with dependencies
- Return a JSON plan: [{agent: "type", task: "description", depends_on: []}]`,
    tools: ['memory_search', 'file_read', 'file_list'],
  },

  sysadmin: {
    name: 'SysAdmin',
    model: 'claude-haiku-4-5',
    max_iterations: 5,
    system_prompt: `You are a system administration agent. Your job is to manage the Mac system.
- Execute system commands carefully
- Check system status and resources
- Manage files and directories
- Monitor processes
- Do NOT make destructive changes without explicit instruction
- Return system status and any actions taken`,
    tools: ['terminal_exec', 'file_read', 'file_list', 'system_info', 'take_screenshot'],
  },
};

// ============================================================================
// SUB-AGENT EXECUTOR
// ============================================================================

/**
 * Execute a single sub-agent call via AI Gateway Bedrock.
 * This is a lightweight wrapper -- no BrainOrchestrator instantiation.
 */
async function callSubAgent(profile, userMessage, context = {}) {
  const startTime = Date.now();
  const model = context.model || profile.model;
  const bedrockPath = BEDROCK_PATHS[model];

  if (!bedrockPath) {
    throw new Error(`Unknown model: ${model}`);
  }

  // Build tool schemas for this agent's allowed tools
  const toolSchemas = (context.allToolSchemas || [])
    .filter(t => profile.tools.includes(t.name));

  // Build messages
  const messages = [
    { role: 'user', content: userMessage },
  ];

  // Add context from previous agents if provided
  if (context.previousResults) {
    const contextText = context.previousResults
      .map(r => `[${r.agent}]: ${r.summary}`)
      .join('\n\n');
    messages[0].content = `Context from previous agents:\n${contextText}\n\nYour task: ${userMessage}`;
  }

  const requestBody = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 4096,
    system: profile.system_prompt,
    messages,
    tools: toolSchemas.length > 0 ? toolSchemas : undefined,
  };

  // Agent loop: handle tool calls
  let iterations = 0;
  const maxIter = context.max_iterations || profile.max_iterations || MAX_SUB_AGENT_ITERATIONS;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const toolsUsed = [];

  while (iterations < maxIter) {
    iterations++;

    const response = await makeBedrockRequest(bedrockPath, requestBody);

    totalInputTokens += response.usage?.input_tokens || 0;
    totalOutputTokens += response.usage?.output_tokens || 0;

    // Check for tool use
    const toolUseBlocks = (response.content || []).filter(b => b.type === 'tool_use');
    const textBlocks = (response.content || []).filter(b => b.type === 'text');

    if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
      // No more tool calls -- agent is done
      const finalText = textBlocks.map(b => b.text).join('\n');
      const duration = Date.now() - startTime;
      const cost = calculateCost(model, totalInputTokens, totalOutputTokens);

      return {
        agent: profile.name,
        model,
        response: finalText,
        iterations,
        tools_used: toolsUsed,
        usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens },
        cost,
        duration_ms: duration,
      };
    }

    // Execute tool calls
    const toolResults = [];
    for (const toolUse of toolUseBlocks) {
      toolsUsed.push(toolUse.name);

      let result;
      if (context.toolExecutor) {
        try {
          result = await context.toolExecutor.executeTool(toolUse.name, toolUse.input);
        } catch (err) {
          result = { is_error: true, error: err.message };
        }
      } else {
        result = { is_error: true, error: 'No tool executor available' };
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(result).substring(0, 10000),
      });
    }

    // Add assistant response and tool results to conversation
    requestBody.messages.push({ role: 'assistant', content: response.content });
    requestBody.messages.push({ role: 'user', content: toolResults });
  }

  // Hit max iterations
  const duration = Date.now() - startTime;
  return {
    agent: profile.name,
    model,
    response: '[Max iterations reached]',
    iterations,
    tools_used: toolsUsed,
    usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens },
    cost: calculateCost(model, totalInputTokens, totalOutputTokens),
    duration_ms: duration,
  };
}

// ============================================================================
// ORCHESTRATION PATTERNS
// ============================================================================

/**
 * Sequential orchestration: agents execute one after another,
 * each receiving the previous agent's output as context.
 */
async function orchestrateSequential(steps, context = {}) {
  const results = [];
  const startTime = Date.now();

  for (const step of steps) {
    const profile = AGENT_PROFILES[step.agent];
    if (!profile) {
      results.push({ agent: step.agent, error: `Unknown agent profile: ${step.agent}` });
      continue;
    }

    const result = await callSubAgent(profile, step.task, {
      ...context,
      previousResults: results,
      model: step.model || profile.model,
    });

    results.push({
      ...result,
      step_name: step.name || step.agent,
      summary: result.response.substring(0, 500),
    });
  }

  return {
    pattern: 'sequential',
    steps: results,
    total_duration_ms: Date.now() - startTime,
    total_cost: results.reduce((sum, r) => sum + (r.cost || 0), 0),
    total_tokens: results.reduce((sum, r) => sum + (r.usage?.input_tokens || 0) + (r.usage?.output_tokens || 0), 0),
  };
}

/**
 * Parallel orchestration: agents execute concurrently.
 * Used when sub-tasks are independent.
 */
async function orchestrateParallel(steps, context = {}) {
  const startTime = Date.now();

  const promises = steps.map(async (step) => {
    const profile = AGENT_PROFILES[step.agent];
    if (!profile) {
      return { agent: step.agent, error: `Unknown agent profile: ${step.agent}` };
    }

    const result = await callSubAgent(profile, step.task, {
      ...context,
      model: step.model || profile.model,
    });

    return {
      ...result,
      step_name: step.name || step.agent,
      summary: result.response.substring(0, 500),
    };
  });

  const results = await Promise.all(promises);

  return {
    pattern: 'parallel',
    steps: results,
    total_duration_ms: Date.now() - startTime,
    total_cost: results.reduce((sum, r) => sum + (r.cost || 0), 0),
    total_tokens: results.reduce((sum, r) => sum + (r.usage?.input_tokens || 0) + (r.usage?.output_tokens || 0), 0),
  };
}

/**
 * Plan-then-execute: planner agent decomposes the task,
 * then sub-agents execute each step.
 */
async function orchestratePlanAndExecute(task, context = {}) {
  const startTime = Date.now();

  // Step 1: Plan
  const plannerProfile = AGENT_PROFILES.planner;
  const planResult = await callSubAgent(plannerProfile, task, context);

  // Try to extract JSON plan from planner response
  let plan;
  try {
    const jsonMatch = planResult.response.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      plan = JSON.parse(jsonMatch[0]);
    }
  } catch {
    // Plan parsing failed, fall back to single-agent
    return {
      pattern: 'plan_and_execute',
      plan_error: 'Failed to parse planner output',
      planner_response: planResult.response,
      steps: [],
      total_duration_ms: Date.now() - startTime,
      total_cost: planResult.cost || 0,
    };
  }

  if (!plan || !Array.isArray(plan) || plan.length === 0) {
    return {
      pattern: 'plan_and_execute',
      plan_error: 'Planner returned empty or invalid plan',
      planner_response: planResult.response,
      steps: [],
      total_duration_ms: Date.now() - startTime,
      total_cost: planResult.cost || 0,
    };
  }

  // Step 2: Execute plan steps (respecting dependencies)
  const results = [{ agent: 'planner', step_name: 'planning', summary: planResult.response.substring(0, 500), cost: planResult.cost, duration_ms: planResult.duration_ms }];
  const completed = new Set();

  // Simple topological execution
  let maxRounds = plan.length + 1;
  while (completed.size < plan.length && maxRounds-- > 0) {
    const ready = plan.filter((step, idx) => {
      if (completed.has(idx)) return false;
      const deps = step.depends_on || [];
      return deps.every(d => completed.has(d));
    });

    if (ready.length === 0) break;

    // Execute ready steps in parallel
    const readyResults = await Promise.all(
      ready.map(async (step) => {
        const profile = AGENT_PROFILES[step.agent] || AGENT_PROFILES.researcher;
        return callSubAgent(profile, step.task, {
          ...context,
          previousResults: results,
        });
      })
    );

    for (let i = 0; i < ready.length; i++) {
      const idx = plan.indexOf(ready[i]);
      completed.add(idx);
      results.push({
        ...readyResults[i],
        step_name: ready[i].name || `step-${idx}`,
        summary: readyResults[i].response.substring(0, 500),
      });
    }
  }

  return {
    pattern: 'plan_and_execute',
    plan,
    steps: results,
    total_duration_ms: Date.now() - startTime,
    total_cost: results.reduce((sum, r) => sum + (r.cost || 0), 0),
    total_tokens: results.reduce((sum, r) => sum + (r.usage?.input_tokens || 0) + (r.usage?.output_tokens || 0), 0),
  };
}

// ============================================================================
// AI GATEWAY BEDROCK REQUEST
// ============================================================================

function makeBedrockRequest(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);

    const options = {
      hostname: AI_GATEWAY_HOST,
      port: 443,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AI_GATEWAY_KEY}`,
        'anthropic_version': 'bedrock-2023-05-31',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: SUB_AGENT_TIMEOUT,
    };

    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => { responseData += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(responseData);
          if (res.statusCode >= 400) {
            reject(new Error(`API error ${res.statusCode}: ${parsed.error?.message || responseData.substring(0, 200)}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Failed to parse response: ${responseData.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.write(data);
    req.end();
  });
}

function calculateCost(model, inputTokens, outputTokens) {
  const pricing = PRICING[model] || PRICING['claude-haiku-4-5'];
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1000000;
}

// ============================================================================
// EXPRESS ROUTES
// ============================================================================

function mountAgentRoutes(app, toolExecutor, allToolSchemas) {
  const sharedContext = { toolExecutor, allToolSchemas };

  /**
   * POST /brain/agents/delegate - Delegate a task to a sub-agent
   */
  app.post('/brain/agents/delegate', async (req, res) => {
    try {
      const { agent, task, model } = req.body;
      if (!agent || !task) {
        return res.status(400).json({ success: false, error: 'Missing agent or task' });
      }

      const profile = AGENT_PROFILES[agent];
      if (!profile) {
        return res.status(400).json({
          success: false,
          error: `Unknown agent: ${agent}. Available: ${Object.keys(AGENT_PROFILES).join(', ')}`,
        });
      }

      const result = await callSubAgent(profile, task, {
        ...sharedContext,
        model: model || profile.model,
      });

      res.json({ success: true, ...result });
    } catch (err) {
      console.error('[agents] Delegate error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /brain/agents/orchestrate - Run a multi-step agent workflow
   */
  app.post('/brain/agents/orchestrate', async (req, res) => {
    try {
      const { pattern, steps, task } = req.body;

      let result;
      switch (pattern) {
        case 'sequential':
          if (!steps) return res.status(400).json({ success: false, error: 'Missing steps' });
          result = await orchestrateSequential(steps, sharedContext);
          break;

        case 'parallel':
          if (!steps) return res.status(400).json({ success: false, error: 'Missing steps' });
          result = await orchestrateParallel(steps, sharedContext);
          break;

        case 'plan_and_execute':
          if (!task) return res.status(400).json({ success: false, error: 'Missing task' });
          result = await orchestratePlanAndExecute(task, sharedContext);
          break;

        default:
          return res.status(400).json({
            success: false,
            error: `Unknown pattern: ${pattern}. Available: sequential, parallel, plan_and_execute`,
          });
      }

      res.json({ success: true, ...result });
    } catch (err) {
      console.error('[agents] Orchestrate error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /brain/agents/profiles - List available agent profiles
   */
  app.get('/brain/agents/profiles', (req, res) => {
    const profiles = Object.entries(AGENT_PROFILES).map(([key, profile]) => ({
      id: key,
      name: profile.name,
      model: profile.model,
      max_iterations: profile.max_iterations,
      tools: profile.tools,
      description: profile.system_prompt.split('\n')[0],
    }));
    res.json({ success: true, profiles });
  });

  /**
   * GET /brain/agents/health - Agent system health
   */
  app.get('/brain/agents/health', (req, res) => {
    res.json({
      status: 'healthy',
      profiles: Object.keys(AGENT_PROFILES).length,
      patterns: ['sequential', 'parallel', 'plan_and_execute'],
      models: Object.keys(BEDROCK_PATHS),
    });
  });

  console.log('[agents] Routes mounted: /brain/agents/*');
}

// ============================================================================
// TOOL SCHEMAS (for brain.js)
// ============================================================================

const AGENT_TOOL_SCHEMAS = [
  {
    name: 'delegate_to_agent',
    description: 'Delegate a task to a specialized sub-agent. Available agents: researcher (web/memory search, cheap), coder (terminal/file ops, medium), reviewer (code review, cheap), planner (task decomposition, medium), sysadmin (system commands, cheap). Use for complex tasks that benefit from specialization.',
    input_schema: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          enum: ['researcher', 'coder', 'reviewer', 'planner', 'sysadmin'],
          description: 'Which specialist agent to delegate to.',
        },
        task: {
          type: 'string',
          description: 'Clear description of what the agent should do.',
        },
        model: {
          type: 'string',
          enum: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6'],
          description: 'Override the agent default model. Only use opus for critical complex tasks.',
        },
      },
      required: ['agent', 'task'],
    },
  },
  {
    name: 'orchestrate_agents',
    description: 'Run a multi-agent workflow. Patterns: sequential (agents run in order, each gets previous output), parallel (agents run concurrently), plan_and_execute (planner decomposes task, then agents execute steps). Use for complex multi-step tasks.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          enum: ['sequential', 'parallel', 'plan_and_execute'],
          description: 'Orchestration pattern.',
        },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              agent: { type: 'string', description: 'Agent type (researcher, coder, reviewer, planner, sysadmin)' },
              task: { type: 'string', description: 'Task description for this agent' },
              name: { type: 'string', description: 'Step name for reference' },
            },
          },
          description: 'Steps for sequential/parallel patterns. Each step has agent type and task.',
        },
        task: {
          type: 'string',
          description: 'High-level task for plan_and_execute pattern. Planner agent will decompose it.',
        },
      },
      required: ['pattern'],
    },
  },
];

// ============================================================================
// MODULE EXPORTS
// ============================================================================

module.exports = {
  AGENT_PROFILES,
  callSubAgent,
  orchestrateSequential,
  orchestrateParallel,
  orchestratePlanAndExecute,
  mountAgentRoutes,
  AGENT_TOOL_SCHEMAS,
};
