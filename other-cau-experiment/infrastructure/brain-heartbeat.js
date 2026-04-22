const fs = require('fs');
const path = require('path');
const https = require('https');

// AI Gateway Bedrock config (matches computer-use.js and brain.js)
const AI_GATEWAY_HOST = 'ai-gateway.happycapy.ai';
const AI_GATEWAY_KEY = process.env.AI_GATEWAY_API_KEY || 'cc00f875633a4dca884e24f5ab6e0106';
const HAIKU_BEDROCK_PATH = '/api/v1/bedrock/model/claude-haiku-4-5/invoke';

// Dynamic imports for ESM modules (fallback for direct API mode)
let Anthropic = null;
async function loadDeps() {
  if (!Anthropic) {
    try {
      const mod = await import('@anthropic-ai/sdk');
      Anthropic = mod.default || mod.Anthropic || mod;
    } catch (err) {
      console.error('[brain-heartbeat] Failed to load @anthropic-ai/sdk:', err.message);
    }
  }
}

/**
 * Call Haiku via AI Gateway Bedrock endpoint (raw HTTPS)
 */
function callHaikuGateway(params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: params.max_tokens || 500,
      messages: params.messages,
      tools: params.tools,
      tool_choice: params.tool_choice,
    });

    const options = {
      hostname: AI_GATEWAY_HOST,
      path: HAIKU_BEDROCK_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AI_GATEWAY_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`Haiku gateway error ${res.statusCode}: ${parsed.message || data.slice(0, 200)}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error(`Parse error: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Haiku gateway timeout')); });
    req.write(body);
    req.end();
  });
}

// HTTP helper using native fetch (Node 18+)
async function httpGet(url, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function httpPost(url, body, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// Configuration
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.BRAIN_HEARTBEAT_INTERVAL_MS || '1800000', 10); // 30 min
const QUIET_HOURS_START = parseInt(process.env.BRAIN_QUIET_HOURS_START || '22', 10);
const QUIET_HOURS_END = parseInt(process.env.BRAIN_QUIET_HOURS_END || '8', 10);
const BOOTSTRAP_DIR = process.env.BRAIN_BOOTSTRAP_DIR || path.join(__dirname, '..', 'brain');

// Scheduled tasks (cron-like)
const SCHEDULES = [
  {
    name: 'morning_briefing',
    hour: 8,
    minute: 0,
    task: 'Prepare morning briefing: calendar today, pending reminders, morning queue items'
  },
  {
    name: 'nightly_consolidation',
    hour: 23,
    minute: 0,
    task: 'Run nightly memory consolidation, update MEMORY.md, summarize today'
  },
  {
    name: 'weekly_review',
    dayOfWeek: 0,
    hour: 10,
    minute: 0,
    task: 'Weekly review: archive old memories, review learned skills, system health report'
  }
];

// State
let heartbeatInterval = null;
let scheduleInterval = null;
let brainExecuteFn = null;
let lastHeartbeat = null;
let lastScheduleFired = {};
let anthropicClient = null;

// Ensure directories exist
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// Initialize Anthropic client (supports AI Gateway + direct API)
async function initAnthropicClient() {
  await loadDeps();
  if (!anthropicClient && Anthropic) {
    const gatewayKey = AI_GATEWAY_KEY;
    const baseURL = process.env.ANTHROPIC_BASE_URL;
    const directKey = process.env.ANTHROPIC_API_KEY;

    if (gatewayKey && baseURL) {
      // AI Gateway mode
      const clientOpts = {
        authToken: gatewayKey,
        baseURL: baseURL,
        defaultHeaders: {
          'Origin': 'https://trickle.so',
          'User-Agent': 'capy-brain-heartbeat/1.0',
        },
      };
      const customHeaders = process.env.ANTHROPIC_CUSTOM_HEADERS;
      if (customHeaders) {
        const [name, ...valueParts] = customHeaders.split(':');
        clientOpts.defaultHeaders[name] = valueParts.join(':');
      }
      anthropicClient = new Anthropic(clientOpts);
      log('Initialized Haiku client via AI Gateway');
    } else if (directKey) {
      // Direct Anthropic API
      anthropicClient = new Anthropic({ apiKey: directKey });
      log('Initialized Haiku client via direct Anthropic API');
    }
  }
  return anthropicClient;
}

// Check if current time is in quiet hours
function isQuietHours() {
  const now = new Date();
  const hour = now.getHours();

  if (QUIET_HOURS_START < QUIET_HOURS_END) {
    // Normal range (e.g., 22:00-08:00 would not fall here)
    return hour >= QUIET_HOURS_START && hour < QUIET_HOURS_END;
  } else {
    // Wraps midnight (e.g., 22:00-08:00)
    return hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;
  }
}

// Get upcoming calendar events (2 hours)
async function getUpcomingCalendar() {
  try {
    // Try HTTP endpoint first
    const data = await httpGet('http://localhost:7888/calendar?hours=2', 5000);
    return data;
  } catch (err) {
    // Fallback to terminal osascript if available
    console.log('[brain-heartbeat] Calendar HTTP failed, skipping calendar check:', err.message);
    return { events: [], error: err.message };
  }
}

// Get service health status
async function getHealthStatus() {
  const health = {
    bridge: { status: 'unknown', latency_ms: 0 },
    kokoro_tts: { status: 'unknown', latency_ms: 0 },
    showui: { status: 'unknown' },
    tunnel: { status: 'unknown' },
    system: { disk_free_gb: 0, memory_used_pct: 0 }
  };

  // Bridge health
  try {
    const start = Date.now();
    await httpGet('http://localhost:7888/health', 3000);
    health.bridge.status = 'ok';
    health.bridge.latency_ms = Date.now() - start;
  } catch (err) {
    health.bridge.status = 'error';
    health.bridge.error = err.message;
  }

  // Kokoro TTS health
  try {
    const start = Date.now();
    await httpGet('http://localhost:7892/health', 3000);
    health.kokoro_tts.status = 'ok';
    health.kokoro_tts.latency_ms = Date.now() - start;
  } catch (err) {
    health.kokoro_tts.status = 'unavailable';
    health.kokoro_tts.error = err.message;
  }

  // ShowUI worker (check if process running via terminal exec)
  try {
    const response = await httpPost('http://localhost:7888/terminal/exec', {
      command: 'pgrep -f showui-worker.py'
    }, 3000);

    if (response && response.stdout && response.stdout.trim()) {
      health.showui.status = 'ok';
      health.showui.pid = response.stdout.trim();
    } else {
      health.showui.status = 'unavailable';
    }
  } catch (err) {
    health.showui.status = 'error';
    health.showui.error = err.message;
  }

  // Tunnel status
  if (process.env.CAPY_BRIDGE_TUNNEL_URL) {
    health.tunnel.status = 'ok';
    health.tunnel.url = process.env.CAPY_BRIDGE_TUNNEL_URL;
  } else {
    health.tunnel.status = 'unknown';
  }

  // System stats (disk and memory)
  try {
    const dfResponse = await httpPost('http://localhost:7888/terminal/exec', {
      command: "df -h / | tail -1 | awk '{print $4}'"
    }, 3000);

    if (dfResponse && dfResponse.stdout) {
      const diskFree = dfResponse.stdout.trim();
      const match = diskFree.match(/(\d+(?:\.\d+)?)/);
      if (match) {
        health.system.disk_free_gb = parseFloat(match[1]);
      }
    }

    // macOS uses vm_stat, not free
    const memResponse = await httpPost('http://localhost:7888/terminal/exec', {
      command: "memory_pressure | head -1 | grep -oE '[0-9]+%' || echo '0%'"
    }, 3000);

    if (memResponse && memResponse.stdout) {
      const memUsed = memResponse.stdout.trim().replace('%', '');
      health.system.memory_used_pct = parseFloat(memUsed) || 0;
    }
  } catch (err) {
    console.log('[brain-heartbeat] System stats check failed:', err.message);
  }

  return health;
}

// Read HEARTBEAT.md
function readHeartbeatFile() {
  const heartbeatPath = path.join(BOOTSTRAP_DIR, 'HEARTBEAT.md');
  try {
    if (fs.existsSync(heartbeatPath)) {
      return fs.readFileSync(heartbeatPath, 'utf8');
    }
    return '# HEARTBEAT\n\nNo tasks configured.';
  } catch (err) {
    console.error('[brain-heartbeat] Failed to read HEARTBEAT.md:', err.message);
    return '# HEARTBEAT\n\nError reading heartbeat file.';
  }
}

// Append to morning queue
function appendToMorningQueue(entry) {
  ensureDir(BOOTSTRAP_DIR);
  const queuePath = path.join(BOOTSTRAP_DIR, 'morning-queue.jsonl');
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...entry,
    source: 'heartbeat'
  }) + '\n';

  try {
    fs.appendFileSync(queuePath, line, 'utf8');
    console.log('[brain-heartbeat] Added to morning queue:', entry.task);
  } catch (err) {
    console.error('[brain-heartbeat] Failed to append to morning queue:', err.message);
  }
}

// Read morning queue
function readMorningQueue() {
  const queuePath = path.join(BOOTSTRAP_DIR, 'morning-queue.jsonl');
  try {
    if (!fs.existsSync(queuePath)) {
      return [];
    }
    const content = fs.readFileSync(queuePath, 'utf8');
    return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (err) {
    console.error('[brain-heartbeat] Failed to read morning queue:', err.message);
    return [];
  }
}

// Clear morning queue (backup to dated file)
function clearMorningQueue() {
  const queuePath = path.join(BOOTSTRAP_DIR, 'morning-queue.jsonl');
  try {
    if (!fs.existsSync(queuePath)) {
      return;
    }

    const dateStr = new Date().toISOString().split('T')[0];
    const backupPath = path.join(BOOTSTRAP_DIR, `morning-queue-${dateStr}.jsonl.bak`);
    fs.renameSync(queuePath, backupPath);
    console.log('[brain-heartbeat] Morning queue cleared, backed up to:', backupPath);
  } catch (err) {
    console.error('[brain-heartbeat] Failed to clear morning queue:', err.message);
  }
}

// Log heartbeat to JSONL
function logHeartbeat(entry) {
  ensureDir(BOOTSTRAP_DIR);
  const logPath = path.join(BOOTSTRAP_DIR, 'heartbeat.jsonl');
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...entry
  }) + '\n';

  try {
    fs.appendFileSync(logPath, line, 'utf8');
  } catch (err) {
    console.error('[brain-heartbeat] Failed to log heartbeat:', err.message);
  }
}

// Call Haiku for heartbeat decision
async function callHaikuGatekeeper() {
  const useGateway = !!AI_GATEWAY_KEY;
  const client = useGateway ? null : await initAnthropicClient();
  if (!useGateway && !client) {
    throw new Error('No API key configured (set AI_GATEWAY_API_KEY or ANTHROPIC_API_KEY)');
  }

  const heartbeatContent = readHeartbeatFile();
  const health = await getHealthStatus();
  const calendar = await getUpcomingCalendar();
  const quietHours = isQuietHours();

  const now = new Date();
  const timeStr = now.toLocaleString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  // Build context for Haiku
  let calendarText = 'No calendar access';
  if (calendar.events && calendar.events.length > 0) {
    calendarText = `Upcoming events (next 2h):\n${calendar.events.map(e =>
      `- ${e.title} at ${e.start}`
    ).join('\n')}`;
  } else if (calendar.events) {
    calendarText = 'No upcoming events in next 2 hours';
  }

  let healthText = `Bridge: ${health.bridge.status}`;
  if (health.kokoro_tts.status !== 'ok') {
    healthText += `, Kokoro TTS: ${health.kokoro_tts.status}`;
  }
  if (health.showui.status !== 'ok') {
    healthText += `, ShowUI: ${health.showui.status}`;
  }

  const prompt = `You are the heartbeat gatekeeper for the capy-brain system. Review the current state and decide if any action is needed.

Current time: ${timeStr}
Quiet hours: ${quietHours ? 'YES (22:00-08:00)' : 'NO'}

Service health:
${healthText}

${calendarText}

Heartbeat tasks:
${heartbeatContent}

Based on the above, decide whether to:
- "skip" this heartbeat (nothing urgent to do)
- "run" a specific task (describe what task and why)

If running a task during quiet hours, set urgency to "high" ONLY if it's truly urgent. Otherwise, it will be deferred to the morning queue.

Use the heartbeat_decision tool to make your decision.`;

  const apiParams = {
    max_tokens: 500,
    tools: [{
      name: 'heartbeat_decision',
      description: 'Make a heartbeat decision',
      input_schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['skip', 'run'],
            description: 'Whether to skip this heartbeat or run a task'
          },
          task: {
            type: 'string',
            description: 'What task to execute if action is run'
          },
          urgency: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
            description: 'Urgency level of the task'
          },
          reason: {
            type: 'string',
            description: 'Brief explanation for this decision'
          }
        },
        required: ['action', 'reason']
      }
    }],
    tool_choice: {
      type: 'tool',
      name: 'heartbeat_decision'
    },
    messages: [{
      role: 'user',
      content: prompt
    }]
  };

  // Use gateway if available, else direct SDK
  let response;
  if (useGateway) {
    response = await callHaikuGateway(apiParams);
  } else if (client) {
    response = await client.messages.create({
      model: 'claude-haiku-4-5',
      ...apiParams,
    });
  } else {
    throw new Error('No API client available');
  }

  // Extract tool use
  const toolUse = response.content.find(block => block.type === 'tool_use');
  if (!toolUse || toolUse.name !== 'heartbeat_decision') {
    throw new Error('Haiku did not return a heartbeat_decision');
  }

  return {
    decision: toolUse.input,
    health,
    quietHours
  };
}

// Execute heartbeat
async function executeHeartbeat() {
  const startTime = Date.now();
  console.log('[brain-heartbeat] Running heartbeat check...');

  try {
    const { decision, health, quietHours } = await callHaikuGatekeeper();

    console.log('[brain-heartbeat] Decision:', decision.action, '-', decision.reason);

    const logEntry = {
      decision: decision.action,
      task: decision.task || null,
      urgency: decision.urgency || null,
      reason: decision.reason,
      quiet_hours: quietHours,
      health_summary: {
        bridge: health.bridge.status,
        kokoro_tts: health.kokoro_tts.status,
        showui: health.showui.status,
        tunnel: health.tunnel.status
      },
      duration_ms: Date.now() - startTime
    };

    if (decision.action === 'run' && decision.task) {
      // Check if we should defer to morning queue
      if (quietHours && decision.urgency !== 'high') {
        console.log('[brain-heartbeat] Deferring to morning queue (quiet hours, not urgent)');
        appendToMorningQueue({
          task: decision.task,
          urgency: decision.urgency || 'medium',
          reason: decision.reason
        });
        logEntry.deferred = true;
      } else {
        // Execute the task
        console.log('[brain-heartbeat] Executing task:', decision.task);
        if (brainExecuteFn) {
          try {
            await brainExecuteFn(decision.task);
            logEntry.executed = true;
          } catch (err) {
            console.error('[brain-heartbeat] Task execution failed:', err.message);
            logEntry.execution_error = err.message;
          }
        } else {
          console.warn('[brain-heartbeat] No brain execute function configured');
          logEntry.execution_error = 'No brain execute function';
        }
      }
    }

    logHeartbeat(logEntry);
    lastHeartbeat = {
      timestamp: new Date().toISOString(),
      ...logEntry
    };

  } catch (err) {
    console.error('[brain-heartbeat] Heartbeat failed:', err.message);
    logHeartbeat({
      decision: 'error',
      reason: err.message,
      duration_ms: Date.now() - startTime
    });
  }
}

// Check and fire scheduled tasks
async function checkScheduledTasks() {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const dayOfWeek = now.getDay();

  for (const schedule of SCHEDULES) {
    const scheduleKey = `${schedule.name}_${now.toISOString().split('T')[0]}`;

    // Check if already fired today
    if (lastScheduleFired[scheduleKey]) {
      continue;
    }

    // Check if time matches
    const hourMatch = schedule.hour === hour;
    const minuteMatch = schedule.minute === minute;
    const dayMatch = schedule.dayOfWeek === undefined || schedule.dayOfWeek === dayOfWeek;

    if (hourMatch && minuteMatch && dayMatch) {
      console.log('[brain-heartbeat] Firing scheduled task:', schedule.name);
      lastScheduleFired[scheduleKey] = new Date().toISOString();

      // Special handling for morning briefing (process queue)
      if (schedule.name === 'morning_briefing') {
        const queue = readMorningQueue();
        let task = schedule.task;
        if (queue.length > 0) {
          task += `\n\nMorning queue (${queue.length} items):\n${queue.map(q =>
            `- [${q.urgency}] ${q.task} (${q.reason})`
          ).join('\n')}`;
          clearMorningQueue();
        }

        if (brainExecuteFn) {
          try {
            await brainExecuteFn(task);
            logHeartbeat({
              decision: 'scheduled',
              task: schedule.name,
              executed: true,
              queue_items: queue.length
            });
          } catch (err) {
            console.error('[brain-heartbeat] Scheduled task failed:', err.message);
            logHeartbeat({
              decision: 'scheduled',
              task: schedule.name,
              execution_error: err.message
            });
          }
        }
      } else {
        // Regular scheduled task
        if (brainExecuteFn) {
          try {
            await brainExecuteFn(schedule.task);
            logHeartbeat({
              decision: 'scheduled',
              task: schedule.name,
              executed: true
            });
          } catch (err) {
            console.error('[brain-heartbeat] Scheduled task failed:', err.message);
            logHeartbeat({
              decision: 'scheduled',
              task: schedule.name,
              execution_error: err.message
            });
          }
        }
      }
    }
  }

  // Clean up old entries (keep only today's)
  const today = now.toISOString().split('T')[0];
  for (const key in lastScheduleFired) {
    if (!key.includes(today)) {
      delete lastScheduleFired[key];
    }
  }
}

// Initialize heartbeat system
function initHeartbeat(brainExecute) {
  brainExecuteFn = brainExecute;
  ensureDir(BOOTSTRAP_DIR);
  console.log('[brain-heartbeat] Initialized with brain execute function');
}

// Start heartbeat
function startHeartbeat() {
  if (heartbeatInterval) {
    console.log('[brain-heartbeat] Already running');
    return;
  }

  console.log(`[brain-heartbeat] Starting heartbeat (interval: ${HEARTBEAT_INTERVAL_MS}ms)`);
  console.log(`[brain-heartbeat] Quiet hours: ${QUIET_HOURS_START}:00 - ${QUIET_HOURS_END}:00`);

  // Initial heartbeat after 10 seconds
  setTimeout(() => {
    executeHeartbeat().catch(err => {
      console.error('[brain-heartbeat] Initial heartbeat failed:', err.message);
    });
  }, 10000);

  // Periodic heartbeat
  heartbeatInterval = setInterval(() => {
    executeHeartbeat().catch(err => {
      console.error('[brain-heartbeat] Heartbeat failed:', err.message);
    });
  }, HEARTBEAT_INTERVAL_MS);

  // Scheduled tasks check (every minute)
  scheduleInterval = setInterval(() => {
    checkScheduledTasks().catch(err => {
      console.error('[brain-heartbeat] Schedule check failed:', err.message);
    });
  }, 60000); // 1 minute
}

// Stop heartbeat
function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    console.log('[brain-heartbeat] Stopped heartbeat');
  }
  if (scheduleInterval) {
    clearInterval(scheduleInterval);
    scheduleInterval = null;
    console.log('[brain-heartbeat] Stopped schedule checker');
  }
}

// Mount Express routes
function mountHeartbeatRoutes(app) {
  // Get current heartbeat status
  app.get('/brain/heartbeat/status', (req, res) => {
    const nextRun = heartbeatInterval ?
      new Date(Date.now() + HEARTBEAT_INTERVAL_MS).toISOString() :
      null;

    res.json({
      running: !!heartbeatInterval,
      interval_ms: HEARTBEAT_INTERVAL_MS,
      quiet_hours: {
        start: QUIET_HOURS_START,
        end: QUIET_HOURS_END,
        active: isQuietHours()
      },
      last_heartbeat: lastHeartbeat,
      next_run: nextRun,
      schedules: SCHEDULES.map(s => ({
        name: s.name,
        time: `${s.hour}:${String(s.minute).padStart(2, '0')}`,
        dayOfWeek: s.dayOfWeek
      }))
    });
  });

  // Manually trigger heartbeat
  app.post('/brain/heartbeat/trigger', async (req, res) => {
    try {
      await executeHeartbeat();
      res.json({
        success: true,
        message: 'Heartbeat triggered',
        result: lastHeartbeat
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err.message
      });
    }
  });

  // Get service health
  app.get('/brain/heartbeat/health', async (req, res) => {
    try {
      const health = await getHealthStatus();
      res.json(health);
    } catch (err) {
      res.status(500).json({
        error: err.message
      });
    }
  });

  // View morning queue
  app.get('/brain/heartbeat/queue', (req, res) => {
    try {
      const queue = readMorningQueue();
      res.json({
        count: queue.length,
        items: queue
      });
    } catch (err) {
      res.status(500).json({
        error: err.message
      });
    }
  });

  // Add one-time scheduled task
  app.post('/brain/heartbeat/schedule', async (req, res) => {
    const { task, delay_minutes } = req.body;

    if (!task) {
      return res.status(400).json({
        error: 'task is required'
      });
    }

    const delayMs = (delay_minutes || 1) * 60000;

    setTimeout(() => {
      console.log('[brain-heartbeat] Firing one-time scheduled task:', task);
      if (brainExecuteFn) {
        brainExecuteFn(task).catch(err => {
          console.error('[brain-heartbeat] One-time task failed:', err.message);
        });
      }
    }, delayMs);

    const executeAt = new Date(Date.now() + delayMs).toISOString();

    res.json({
      success: true,
      task,
      execute_at: executeAt,
      delay_ms: delayMs
    });
  });

  // Update quiet hours config
  app.put('/brain/heartbeat/quiet-hours', (req, res) => {
    const { start, end } = req.body;

    if (typeof start === 'number' && start >= 0 && start < 24) {
      process.env.BRAIN_QUIET_HOURS_START = String(start);
    }

    if (typeof end === 'number' && end >= 0 && end < 24) {
      process.env.BRAIN_QUIET_HOURS_END = String(end);
    }

    res.json({
      success: true,
      quiet_hours: {
        start: parseInt(process.env.BRAIN_QUIET_HOURS_START || '22', 10),
        end: parseInt(process.env.BRAIN_QUIET_HOURS_END || '8', 10),
        active: isQuietHours()
      },
      note: 'Changes take effect immediately but are not persisted across restarts'
    });
  });

  console.log('[brain-heartbeat] Routes mounted');
}

module.exports = {
  mountHeartbeatRoutes,
  initHeartbeat,
  startHeartbeat,
  stopHeartbeat,
  getHealthStatus,
  isQuietHours,
  readMorningQueue
};
