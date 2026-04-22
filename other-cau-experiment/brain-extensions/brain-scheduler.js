/**
 * Brain Scheduler Module - Proactive Task Scheduling for Jarvis
 *
 * Enables the AI brain to schedule and execute tasks autonomously:
 * - One-time tasks ("remind me at 3pm")
 * - Recurring tasks ("check email every hour")
 * - Cron expressions ("0 9 * * 1-5" = weekdays at 9am)
 * - AI-initiated self-scheduling (brain creates its own tasks)
 * - Task dependencies (B runs after A completes)
 *
 * Uses node-schedule for scheduling + SQLite for persistence across restarts.
 *
 * Axioms:
 * - node-schedule (NOT node-cron) -- supports date objects for one-time tasks
 * - SQLite persistence -- tasks survive server restarts
 * - Express routes -- follows mountXxxRoutes pattern
 * - Tasks can trigger brain queries or tool calls
 * - Rate limited: max 50 tasks/hour per creator
 * - Deduplication via SHA256 signature
 *
 * @module brain-scheduler
 */

const crypto = require('crypto');
const path = require('path');
const { EventEmitter } = require('events');

// node-schedule will be loaded dynamically (may not be installed)
let schedule = null;

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_TASKS_PER_HOUR = 50;
const MAX_ACTIVE_TASKS = 200;
const DEFAULT_PRIORITY = 50;
const EXECUTION_TIMEOUT = 120000; // 2 minutes per task execution
const AUTH_TOKEN = process.env.CAPY_BRIDGE_TOKEN || '';

// ============================================================================
// TASK SCHEDULER
// ============================================================================

class TaskScheduler extends EventEmitter {
  constructor(db, options = {}) {
    super();
    this.db = db;
    this.port = options.port || 7888;
    this.jobs = new Map(); // taskId -> node-schedule Job
    this.executing = new Set(); // currently executing task IDs
    this.initialized = false;
    this.fetch = globalThis.fetch || null;
  }

  /**
   * Initialize: create tables, load persisted tasks, schedule them.
   */
  async init() {
    // Dynamically load node-schedule
    try {
      schedule = require('node-schedule');
    } catch {
      try {
        const mod = await import('node-schedule');
        schedule = mod.default || mod;
      } catch {
        console.warn('[scheduler] node-schedule not installed. Install with: npm install node-schedule');
        console.warn('[scheduler] Running in degraded mode (no scheduling, persistence only)');
      }
    }

    await this.createTables();
    await this.loadAndScheduleTasks();
    await this.handleMissedTasks();
    this.initialized = true;
    console.log(`[scheduler] Initialized. ${this.jobs.size} active tasks loaded.`);
  }

  /**
   * Create SQLite tables for task persistence.
   */
  async createTables() {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        schedule_type TEXT NOT NULL CHECK(schedule_type IN ('cron','date','recurrence','interval')),
        schedule_config TEXT NOT NULL,
        task_type TEXT NOT NULL CHECK(task_type IN ('tool_call','brain_query','notification')),
        task_config TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        created_by TEXT DEFAULT 'user',
        enabled INTEGER DEFAULT 1,
        last_run INTEGER,
        next_run INTEGER,
        run_count INTEGER DEFAULT 0,
        max_runs INTEGER,
        priority INTEGER DEFAULT ${DEFAULT_PRIORITY},
        depends_on TEXT,
        metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS task_executions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT NOT NULL CHECK(status IN ('running','success','failed','missed','skipped')),
        result TEXT,
        error TEXT,
        duration_ms INTEGER,
        FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_task_enabled ON scheduled_tasks(enabled);
      CREATE INDEX IF NOT EXISTS idx_task_next_run ON scheduled_tasks(next_run);
      CREATE INDEX IF NOT EXISTS idx_exec_task_id ON task_executions(task_id);
      CREATE INDEX IF NOT EXISTS idx_exec_started ON task_executions(started_at);
    `);
  }

  /**
   * Load tasks from DB and schedule active ones.
   */
  async loadAndScheduleTasks() {
    if (!schedule) return;

    const tasks = await this.db.all(
      'SELECT * FROM scheduled_tasks WHERE enabled = 1'
    );

    for (const task of tasks) {
      try {
        this.scheduleTask(task);
      } catch (err) {
        console.error(`[scheduler] Failed to schedule task ${task.id}: ${err.message}`);
      }
    }
  }

  /**
   * Handle tasks that were missed during downtime.
   */
  async handleMissedTasks() {
    const now = Math.floor(Date.now() / 1000);
    const missed = await this.db.all(
      `SELECT * FROM scheduled_tasks
       WHERE enabled = 1 AND schedule_type = 'date'
       AND next_run IS NOT NULL AND next_run < ?`,
      [now]
    );

    for (const task of missed) {
      const execId = crypto.randomUUID();
      await this.db.run(
        `INSERT INTO task_executions (id, task_id, started_at, finished_at, status, error)
         VALUES (?, ?, ?, ?, 'missed', 'Server was down during scheduled time')`,
        [execId, task.id, task.next_run, now]
      );
      // Disable one-time tasks that were missed
      if (task.schedule_type === 'date') {
        await this.db.run('UPDATE scheduled_tasks SET enabled = 0 WHERE id = ?', [task.id]);
      }
      console.log(`[scheduler] Marked missed task: ${task.name} (${task.id})`);
    }

    if (missed.length > 0) {
      console.log(`[scheduler] ${missed.length} missed task(s) handled.`);
    }
  }

  /**
   * Create and schedule a new task.
   */
  async createTask(taskDef) {
    // Rate limiting
    const recentCount = await this.db.get(
      `SELECT COUNT(*) as cnt FROM scheduled_tasks
       WHERE created_at > ? AND created_by = ?`,
      [Math.floor(Date.now() / 1000) - 3600, taskDef.created_by || 'user']
    );

    if (recentCount.cnt >= MAX_TASKS_PER_HOUR) {
      throw new Error(`Rate limit: max ${MAX_TASKS_PER_HOUR} tasks per hour per creator`);
    }

    // Check total active tasks
    const activeCount = await this.db.get(
      'SELECT COUNT(*) as cnt FROM scheduled_tasks WHERE enabled = 1'
    );

    if (activeCount.cnt >= MAX_ACTIVE_TASKS) {
      throw new Error(`Max active tasks limit reached (${MAX_ACTIVE_TASKS})`);
    }

    // Deduplication
    const signature = this.generateSignature(taskDef);
    const existing = await this.db.get(
      `SELECT id, name FROM scheduled_tasks WHERE enabled = 1 AND metadata LIKE ?`,
      [`%"signature":"${signature}"%`]
    );

    if (existing) {
      return { id: existing.id, name: existing.name, deduplicated: true };
    }

    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const nextRun = this.calculateNextRun(taskDef.schedule_type, taskDef.schedule_config);

    const metadata = JSON.stringify({
      signature,
      ...(taskDef.metadata || {}),
    });

    await this.db.run(
      `INSERT INTO scheduled_tasks
       (id, name, description, schedule_type, schedule_config, task_type, task_config,
        created_at, created_by, next_run, max_runs, priority, depends_on, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        taskDef.name,
        taskDef.description || null,
        taskDef.schedule_type,
        JSON.stringify(taskDef.schedule_config),
        taskDef.task_type,
        JSON.stringify(taskDef.task_config),
        now,
        taskDef.created_by || 'user',
        nextRun,
        taskDef.max_runs || null,
        taskDef.priority || DEFAULT_PRIORITY,
        taskDef.depends_on ? JSON.stringify(taskDef.depends_on) : null,
        metadata,
      ]
    );

    // Schedule it
    const task = await this.db.get('SELECT * FROM scheduled_tasks WHERE id = ?', [id]);
    if (schedule && task) {
      this.scheduleTask(task);
    }

    console.log(`[scheduler] Created task: ${taskDef.name} (${id}) [${taskDef.schedule_type}]`);
    this.emit('task:created', { id, name: taskDef.name });

    return { id, name: taskDef.name, next_run: nextRun, deduplicated: false };
  }

  /**
   * Schedule a task using node-schedule.
   */
  scheduleTask(task) {
    if (!schedule) return;

    // Cancel existing job if any
    if (this.jobs.has(task.id)) {
      this.jobs.get(task.id).cancel();
    }

    const config = JSON.parse(task.schedule_config);
    let job;

    switch (task.schedule_type) {
      case 'cron':
        job = schedule.scheduleJob(config.expression, () => this.executeTask(task.id));
        break;

      case 'date': {
        const date = new Date(config.timestamp);
        if (date <= new Date()) return; // Past date, skip
        job = schedule.scheduleJob(date, () => this.executeTask(task.id));
        break;
      }

      case 'recurrence': {
        const rule = new schedule.RecurrenceRule();
        if (config.hour !== undefined) rule.hour = config.hour;
        if (config.minute !== undefined) rule.minute = config.minute;
        if (config.dayOfWeek !== undefined) rule.dayOfWeek = config.dayOfWeek;
        if (config.dayOfMonth !== undefined) rule.dayOfMonth = config.dayOfMonth;
        if (config.month !== undefined) rule.month = config.month;
        if (config.tz) rule.tz = config.tz;
        job = schedule.scheduleJob(rule, () => this.executeTask(task.id));
        break;
      }

      case 'interval': {
        // Simple interval in seconds
        const ms = (config.seconds || 60) * 1000;
        const intervalId = setInterval(() => this.executeTask(task.id), ms);
        // Wrap in a pseudo-job object
        job = { cancel: () => clearInterval(intervalId), nextInvocation: () => new Date(Date.now() + ms) };
        break;
      }
    }

    if (job) {
      this.jobs.set(task.id, job);
    }
  }

  /**
   * Execute a scheduled task.
   */
  async executeTask(taskId) {
    // Prevent concurrent execution of the same task
    if (this.executing.has(taskId)) return;

    const task = await this.db.get('SELECT * FROM scheduled_tasks WHERE id = ? AND enabled = 1', [taskId]);
    if (!task) return;

    // Check max_runs
    if (task.max_runs && task.run_count >= task.max_runs) {
      await this.db.run('UPDATE scheduled_tasks SET enabled = 0 WHERE id = ?', [taskId]);
      if (this.jobs.has(taskId)) {
        this.jobs.get(taskId).cancel();
        this.jobs.delete(taskId);
      }
      return;
    }

    // Check dependencies
    if (task.depends_on) {
      const deps = JSON.parse(task.depends_on);
      for (const depId of deps) {
        const lastExec = await this.db.get(
          `SELECT status FROM task_executions WHERE task_id = ? ORDER BY started_at DESC LIMIT 1`,
          [depId]
        );
        if (!lastExec || lastExec.status !== 'success') {
          console.log(`[scheduler] Skipping ${task.name}: dependency ${depId} not satisfied`);
          return;
        }
      }
    }

    this.executing.add(taskId);
    const execId = crypto.randomUUID();
    const startTime = Date.now();
    const startEpoch = Math.floor(startTime / 1000);

    await this.db.run(
      `INSERT INTO task_executions (id, task_id, started_at, status) VALUES (?, ?, ?, 'running')`,
      [execId, taskId, startEpoch]
    );

    try {
      const taskConfig = JSON.parse(task.task_config);
      let result;

      switch (task.task_type) {
        case 'tool_call':
          result = await this.executeToolCall(taskConfig);
          break;
        case 'brain_query':
          result = await this.executeBrainQuery(taskConfig);
          break;
        case 'notification':
          result = await this.executeNotification(taskConfig);
          break;
      }

      const duration = Date.now() - startTime;
      const finishedAt = Math.floor(Date.now() / 1000);

      await this.db.run(
        `UPDATE task_executions SET finished_at = ?, status = 'success', result = ?, duration_ms = ? WHERE id = ?`,
        [finishedAt, JSON.stringify(result), duration, execId]
      );

      await this.db.run(
        'UPDATE scheduled_tasks SET last_run = ?, run_count = run_count + 1 WHERE id = ?',
        [finishedAt, taskId]
      );

      // Disable one-time tasks after execution
      if (task.schedule_type === 'date') {
        await this.db.run('UPDATE scheduled_tasks SET enabled = 0 WHERE id = ?', [taskId]);
        if (this.jobs.has(taskId)) {
          this.jobs.get(taskId).cancel();
          this.jobs.delete(taskId);
        }
      }

      console.log(`[scheduler] Executed: ${task.name} (${duration}ms)`);
      this.emit('task:completed', { id: taskId, name: task.name, duration, result });

    } catch (err) {
      const duration = Date.now() - startTime;
      const finishedAt = Math.floor(Date.now() / 1000);

      await this.db.run(
        `UPDATE task_executions SET finished_at = ?, status = 'failed', error = ?, duration_ms = ? WHERE id = ?`,
        [finishedAt, err.message, duration, execId]
      );

      console.error(`[scheduler] Task failed: ${task.name}: ${err.message}`);
      this.emit('task:failed', { id: taskId, name: task.name, error: err.message });

    } finally {
      this.executing.delete(taskId);
    }
  }

  /**
   * Execute a tool call via ToolExecutor HTTP pattern.
   */
  async executeToolCall(config) {
    if (!this.fetch) {
      try { const m = await import('node-fetch'); this.fetch = m.default; }
      catch { this.fetch = globalThis.fetch; }
    }

    const endpoint = config.endpoint || `/tools/${config.tool}`;
    const response = await this.fetch(`http://localhost:${this.port}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify(config.arguments || {}),
      signal: AbortSignal.timeout(EXECUTION_TIMEOUT),
    });

    return await response.json();
  }

  /**
   * Execute a brain query (sends message to /brain/query).
   */
  async executeBrainQuery(config) {
    if (!this.fetch) {
      try { const m = await import('node-fetch'); this.fetch = m.default; }
      catch { this.fetch = globalThis.fetch; }
    }

    const response = await this.fetch(`http://localhost:${this.port}/brain/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({
        message: config.query,
        session_id: config.session_id || `scheduler-${Date.now()}`,
        model: config.model || undefined,
      }),
      signal: AbortSignal.timeout(EXECUTION_TIMEOUT),
    });

    return await response.json();
  }

  /**
   * Execute a notification via /notification/send.
   */
  async executeNotification(config) {
    if (!this.fetch) {
      try { const m = await import('node-fetch'); this.fetch = m.default; }
      catch { this.fetch = globalThis.fetch; }
    }

    const response = await this.fetch(`http://localhost:${this.port}/system/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({
        title: config.title || 'Jarvis Reminder',
        message: config.message,
        sound: config.sound !== false,
      }),
      signal: AbortSignal.timeout(10000),
    });

    return await response.json();
  }

  /**
   * Cancel a task.
   */
  async cancelTask(taskId) {
    if (this.jobs.has(taskId)) {
      this.jobs.get(taskId).cancel();
      this.jobs.delete(taskId);
    }

    await this.db.run('UPDATE scheduled_tasks SET enabled = 0 WHERE id = ?', [taskId]);
    this.emit('task:cancelled', { id: taskId });
    return { success: true };
  }

  /**
   * List tasks with optional filters.
   */
  async listTasks(filters = {}) {
    let query = 'SELECT * FROM scheduled_tasks WHERE 1=1';
    const params = [];

    if (filters.enabled !== undefined) {
      query += ' AND enabled = ?';
      params.push(filters.enabled ? 1 : 0);
    }
    if (filters.task_type) {
      query += ' AND task_type = ?';
      params.push(filters.task_type);
    }
    if (filters.created_by) {
      query += ' AND created_by = ?';
      params.push(filters.created_by);
    }

    query += ' ORDER BY priority DESC, created_at DESC';

    if (filters.limit) {
      query += ' LIMIT ?';
      params.push(filters.limit);
    }

    const tasks = await this.db.all(query, params);
    return tasks.map(t => ({
      ...t,
      schedule_config: JSON.parse(t.schedule_config),
      task_config: JSON.parse(t.task_config),
      depends_on: t.depends_on ? JSON.parse(t.depends_on) : null,
      metadata: t.metadata ? JSON.parse(t.metadata) : null,
      is_active: this.jobs.has(t.id),
    }));
  }

  /**
   * Get execution history for a task.
   */
  async getExecutions(taskId, limit = 20) {
    return await this.db.all(
      'SELECT * FROM task_executions WHERE task_id = ? ORDER BY started_at DESC LIMIT ?',
      [taskId, limit]
    );
  }

  /**
   * Generate deduplication signature.
   */
  generateSignature(taskDef) {
    const key = JSON.stringify({
      schedule: taskDef.schedule_config,
      action: taskDef.task_config,
    });
    return crypto.createHash('sha256').update(key).digest('hex').substring(0, 16);
  }

  /**
   * Calculate next run time from schedule config.
   */
  calculateNextRun(scheduleType, config) {
    const conf = typeof config === 'string' ? JSON.parse(config) : config;
    const now = Math.floor(Date.now() / 1000);

    switch (scheduleType) {
      case 'date':
        return Math.floor(new Date(conf.timestamp).getTime() / 1000);
      case 'interval':
        return now + (conf.seconds || 60);
      default:
        return null; // Cron/recurrence: let node-schedule figure it out
    }
  }

  /**
   * Graceful shutdown.
   */
  async shutdown() {
    if (schedule) {
      await schedule.gracefulShutdown();
    }
    this.jobs.clear();
    console.log('[scheduler] Shut down gracefully.');
  }
}

// ============================================================================
// EXPRESS ROUTES
// ============================================================================

function mountSchedulerRoutes(app, scheduler) {
  /**
   * POST /scheduler/create - Create a new scheduled task
   */
  app.post('/scheduler/create', async (req, res) => {
    try {
      const result = await scheduler.createTask(req.body);
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('[scheduler] Create error:', err.message);
      res.status(400).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /scheduler/list - List scheduled tasks
   */
  app.get('/scheduler/list', async (req, res) => {
    try {
      const tasks = await scheduler.listTasks({
        enabled: req.query.enabled !== undefined ? req.query.enabled === 'true' : undefined,
        task_type: req.query.task_type,
        created_by: req.query.created_by,
        limit: req.query.limit ? parseInt(req.query.limit) : 50,
      });
      res.json({ success: true, count: tasks.length, tasks });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /scheduler/cancel - Cancel a task
   */
  app.post('/scheduler/cancel', async (req, res) => {
    try {
      const { task_id } = req.body;
      if (!task_id) return res.status(400).json({ success: false, error: 'Missing task_id' });
      const result = await scheduler.cancelTask(task_id);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /scheduler/run-now - Manually trigger a task
   */
  app.post('/scheduler/run-now', async (req, res) => {
    try {
      const { task_id } = req.body;
      if (!task_id) return res.status(400).json({ success: false, error: 'Missing task_id' });
      // Don't await -- run async, return immediately
      scheduler.executeTask(task_id);
      res.json({ success: true, message: 'Task triggered' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /scheduler/executions - Get execution history
   */
  app.get('/scheduler/executions', async (req, res) => {
    try {
      const taskId = req.query.task_id;
      const limit = parseInt(req.query.limit || '20');
      const executions = taskId
        ? await scheduler.getExecutions(taskId, limit)
        : await scheduler.db.all(
            'SELECT * FROM task_executions ORDER BY started_at DESC LIMIT ?',
            [limit]
          );
      res.json({ success: true, executions });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /scheduler/health - Scheduler health
   */
  app.get('/scheduler/health', async (req, res) => {
    try {
      const stats = await scheduler.db.get(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) as active,
          SUM(CASE WHEN enabled = 0 THEN 1 ELSE 0 END) as disabled
        FROM scheduled_tasks
      `);
      const recentExecs = await scheduler.db.get(`
        SELECT COUNT(*) as cnt FROM task_executions WHERE started_at > ?`,
        [Math.floor(Date.now() / 1000) - 3600]
      );

      res.json({
        status: 'healthy',
        node_schedule: !!schedule,
        active_jobs: scheduler.jobs.size,
        executing_now: scheduler.executing.size,
        tasks: stats,
        executions_last_hour: recentExecs.cnt,
      });
    } catch (err) {
      res.status(500).json({ status: 'unhealthy', error: err.message });
    }
  });

  console.log('[scheduler] Routes mounted: /scheduler/*');
}

// ============================================================================
// TOOL SCHEMAS (for brain.js)
// ============================================================================

const SCHEDULER_TOOL_SCHEMAS = [
  {
    name: 'schedule_task',
    description: 'Schedule a task to run at a specific time or on a recurring schedule. Can schedule brain queries (AI thinking), tool calls, or notifications. Use for reminders, recurring checks, automated workflows, and proactive assistance.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Short name for the task (e.g., "Check email", "Daily summary", "Reminder: call John").',
        },
        description: {
          type: 'string',
          description: 'Detailed description of what the task does.',
        },
        schedule_type: {
          type: 'string',
          enum: ['date', 'cron', 'recurrence', 'interval'],
          description: 'Schedule type. date=one-time, cron=cron expression, recurrence=specific times/days, interval=every N seconds.',
        },
        schedule_config: {
          type: 'object',
          description: 'Schedule configuration. For date: {timestamp: ISO8601}. For cron: {expression: "0 9 * * 1-5"}. For recurrence: {hour: [9], minute: [0], dayOfWeek: [1,2,3,4,5]}. For interval: {seconds: 3600}.',
        },
        task_type: {
          type: 'string',
          enum: ['brain_query', 'tool_call', 'notification'],
          description: 'What to execute. brain_query=send message to AI brain, tool_call=call a specific tool, notification=macOS notification.',
        },
        task_config: {
          type: 'object',
          description: 'Task configuration. For brain_query: {query: "message"}. For tool_call: {tool: "name", endpoint: "/path", arguments: {}}. For notification: {title: "...", message: "..."}.',
        },
        max_runs: {
          type: 'number',
          description: 'Maximum number of times to run (null=unlimited). Useful for "do this 3 times then stop".',
        },
        priority: {
          type: 'number',
          description: 'Priority 1-100 (default 50). Higher priority tasks execute first when concurrent.',
        },
      },
      required: ['name', 'schedule_type', 'schedule_config', 'task_type', 'task_config'],
    },
  },
  {
    name: 'cancel_scheduled_task',
    description: 'Cancel a previously scheduled task by its ID. The task will be disabled and no longer execute.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The UUID of the task to cancel.',
        },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'list_scheduled_tasks',
    description: 'List all scheduled tasks with their status, next run time, and execution history. Use to check what automations are active.',
    input_schema: {
      type: 'object',
      properties: {
        enabled: {
          type: 'boolean',
          description: 'Filter by enabled status (true=active, false=disabled).',
        },
        limit: {
          type: 'number',
          description: 'Max results (default 20).',
        },
      },
    },
  },
];

// ============================================================================
// MODULE EXPORTS
// ============================================================================

module.exports = {
  TaskScheduler,
  mountSchedulerRoutes,
  SCHEDULER_TOOL_SCHEMAS,
};
