'use strict';

/**
 * Atlas Web Agent Module
 *
 * Extends the Atlas desktop agent with web capabilities via TinyFish.
 * Three modes:
 *   1. SEARCH  — "I don't know how to do X" → search web for instructions
 *   2. FETCH   — "Get content from URL" → render & extract page content
 *   3. WEB_TASK — "Do X on website Y" → browser automation via TinyFish Agent
 *
 * The brain calls classifyTask() to decide: desktop (AX) vs web (TinyFish).
 */

const tinyfish = require('./tinyfish');
const youtube = require('./atlas-youtube');

const BRAIN_URL = process.env.BRAIN_URL || 'http://localhost:7888/brain/query';

// ─── Task Classification ──────────────────────────────────────
// Ask the brain LLM to classify whether a task is desktop, web, or needs search

async function classifyTask(userRequest, token) {
  const prompt = `You are Atlas, a macOS desktop assistant. Classify this user request into exactly ONE category.

Categories:
- DESKTOP: Task involves native macOS apps, Finder, System Settings, Dock, or any installed app UI
- WEB: Task requires a web browser to visit a website and interact with it (login, fill forms, click buttons on a webpage)
- SEARCH: You don't know the exact steps and need to look up how to do it first
- HYBRID: Starts on desktop (open browser) then continues on a website

User request: "${userRequest}"

Respond with ONLY a JSON object:
{"category": "DESKTOP|WEB|SEARCH|HYBRID", "reason": "one sentence", "url": "target URL if WEB/HYBRID, else null", "searchQuery": "what to search if SEARCH, else null"}`;

  try {
    const res = await fetch(BRAIN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ message: prompt, model: 'haiku' }),
    });

    if (!res.ok) {
      return { category: 'DESKTOP', reason: 'brain unreachable, defaulting to desktop' };
    }

    const data = await res.json();
    const text = data?.data?.response || '';

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { category: 'DESKTOP', reason: 'could not parse classification' };
  } catch (err) {
    console.log(`[atlas-web] classifyTask error: ${err.message}`);
    return { category: 'DESKTOP', reason: 'error, defaulting to desktop' };
  }
}

// ─── Search for How-To ────────────────────────────────────────
// When the agent doesn't know how to do something, search and summarize

async function searchHowTo(query, token) {
  console.log(`[atlas-web] searchHowTo: "${query}"`);

  // Step 1: Search via TinyFish
  const result = await tinyfish.searchAndFetch(`how to ${query} on macOS`, { topN: 2 });
  if (!result.ok) {
    return { ok: false, error: result.error, fallback: 'Could not find instructions online.' };
  }

  // Step 2: Summarize the fetched pages via brain LLM
  const pageTexts = result.pages
    .map(p => `### ${p.title}\n${(p.text || '').slice(0, 2000)}`)
    .join('\n\n---\n\n');

  if (!pageTexts.trim()) {
    return {
      ok: true,
      summary: 'Search returned results but could not extract page content.',
      sources: result.search.slice(0, 3).map(r => ({ title: r.title, url: r.url })),
    };
  }

  const summarizePrompt = `Based on these web pages, give concise step-by-step instructions for: "${query}" on macOS.

${pageTexts}

Respond with numbered steps only. Be specific about which menus, buttons, or keyboard shortcuts to use.`;

  try {
    const res = await fetch(BRAIN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ message: summarizePrompt, model: 'sonnet' }),
    });

    const data = await res.json();
    const summary = data?.data?.response || 'Could not summarize results.';

    return {
      ok: true,
      summary,
      sources: result.search.slice(0, 3).map(r => ({ title: r.title, url: r.url })),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Web Task Execution ───────────────────────────────────────
// Execute a browser-based task via TinyFish Agent API

async function executeWebTask(url, goal) {
  console.log(`[atlas-web] executeWebTask: url=${url} goal="${goal}"`);

  if (!tinyfish.isConfigured()) {
    return { ok: false, error: 'TinyFish API key not configured. Set TINYFISH_API_KEY env var.' };
  }

  // Use async mode so we can report progress
  const start = await tinyfish.runAgentAsync(url, goal);
  if (!start.ok) return start;

  // Poll until complete (max 2 minutes)
  const runId = start.run_id;
  const deadline = Date.now() + 120000;
  let lastStatus = start.status;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    const poll = await tinyfish.getRun(runId);
    if (!poll.ok) continue;

    lastStatus = poll.status;
    if (poll.status === 'COMPLETE' || poll.status === 'completed') {
      return { ok: true, run_id: runId, status: poll.status, result: poll.result };
    }
    if (poll.status === 'FAILED' || poll.status === 'failed' || poll.status === 'CANCELLED') {
      return { ok: false, run_id: runId, status: poll.status, result: poll.result };
    }
  }

  return { ok: false, error: 'timeout', run_id: runId, lastStatus };
}

// ─── Fetch Page Content ───────────────────────────────────────
// Render a URL and extract its content as markdown

async function fetchPage(url) {
  console.log(`[atlas-web] fetchPage: ${url}`);
  return tinyfish.fetchPages(url, { format: 'markdown' });
}

// ─── Main Dispatch ────────────────────────────────────────────
// The unified entry point: takes a user request, classifies it, and acts

async function dispatch(userRequest, token) {
  console.log(`[atlas-web] dispatch: "${userRequest}"`);

  // Step 1: Classify
  const classification = await classifyTask(userRequest, token);
  console.log(`[atlas-web] classified as: ${classification.category} — ${classification.reason}`);

  const response = { classification };

  switch (classification.category) {
    case 'SEARCH': {
      const query = classification.searchQuery || userRequest;
      const result = await searchHowTo(query, token);
      response.action = 'search';
      response.result = result;
      break;
    }

    case 'WEB': {
      if (!classification.url) {
        // No URL — search first to find the right site
        const searchResult = await tinyfish.search(userRequest);
        if (searchResult.ok && searchResult.results.length > 0) {
          const targetUrl = searchResult.results[0].url;
          response.action = 'web_task';
          response.result = await executeWebTask(targetUrl, userRequest);
        } else {
          response.action = 'search_failed';
          response.result = { ok: false, error: 'Could not find target website' };
        }
      } else {
        response.action = 'web_task';
        response.result = await executeWebTask(classification.url, userRequest);
      }
      break;
    }

    case 'HYBRID': {
      // For hybrid: provide both desktop guidance and web execution
      response.action = 'hybrid';
      response.desktopHint = `Open the browser and navigate to ${classification.url || 'the target website'}`;
      if (classification.url) {
        response.webResult = await executeWebTask(classification.url, userRequest);
      }
      break;
    }

    case 'DESKTOP':
    default: {
      // Desktop tasks are handled by the existing AX-based tutorial system
      response.action = 'desktop';
      response.result = { ok: true, message: 'Task classified as desktop — use AX tree for guidance.' };
      break;
    }
  }

  return response;
}

// ─── HTTP Route Handler ───────────────────────────────────────

function mountRoutes(app) {
  // POST /atlas/dispatch — unified entry point
  app.post('/atlas/dispatch', async (req, res) => {
    const { request } = req.body || {};
    if (!request) return res.status(400).json({ error: 'request field is required' });

    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const result = await dispatch(request, token);
    res.json(result);
  });

  // POST /atlas/search — direct web search
  app.post('/atlas/search', async (req, res) => {
    const { query } = req.body || {};
    if (!query) return res.status(400).json({ error: 'query field is required' });

    const result = await tinyfish.search(query);
    res.json(result);
  });

  // POST /atlas/fetch — fetch and extract page content
  app.post('/atlas/fetch', async (req, res) => {
    const { urls } = req.body || {};
    if (!urls) return res.status(400).json({ error: 'urls field is required' });

    const result = await tinyfish.fetchPages(urls);
    res.json(result);
  });

  // POST /atlas/web-task — run a browser automation task
  app.post('/atlas/web-task', async (req, res) => {
    const { url, goal } = req.body || {};
    if (!url || !goal) return res.status(400).json({ error: 'url and goal fields are required' });

    const result = await executeWebTask(url, goal);
    res.json(result);
  });

  // POST /atlas/search-howto — search and summarize instructions
  app.post('/atlas/search-howto', async (req, res) => {
    const { query } = req.body || {};
    if (!query) return res.status(400).json({ error: 'query field is required' });

    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const result = await searchHowTo(query, token);
    res.json(result);
  });

  // GET /atlas/tinyfish-status — check if TinyFish is configured
  app.get('/atlas/tinyfish-status', (req, res) => {
    res.json({
      configured: tinyfish.isConfigured(),
      endpoints: {
        search: tinyfish.isConfigured(),
        fetch: tinyfish.isConfigured(),
        agent: tinyfish.isConfigured(),
      },
    });
  });

  // ─── YouTube Learning Routes ──────────────────────────────────

  // POST /atlas/learn — full pipeline: topic → YouTube → extract → tutorial steps
  app.post('/atlas/learn', async (req, res) => {
    const { topic, targetApp, videoUrl } = req.body || {};
    if (!topic && !videoUrl) return res.status(400).json({ error: 'topic or videoUrl is required' });

    const token = (req.headers.authorization || '').replace('Bearer ', '');

    if (videoUrl) {
      // Direct video URL provided — skip search, go straight to extract + convert
      console.log(`[atlas-web] /atlas/learn from URL: ${videoUrl}`);
      const contentResult = await youtube.extractVideoContent(videoUrl);
      if (!contentResult.ok) return res.json({ ok: false, stage: 'extract', error: contentResult.error });

      const stepsResult = await youtube.convertToTutorialSteps(
        contentResult.content, targetApp || topic || 'the application', BRAIN_URL, token
      );
      return res.json({
        ok: stepsResult.ok,
        video: { url: videoUrl, title: contentResult.content?.title },
        content: contentResult.content,
        steps: stepsResult.steps || [],
        stepsRaw: stepsResult.raw,
        error: stepsResult.error,
      });
    }

    // Full pipeline from topic
    const result = await youtube.learnFromYouTube(topic, {
      targetApp: targetApp || topic,
      brainUrl: BRAIN_URL,
      token,
    });
    res.json(result);
  });

  // POST /atlas/learn/find-videos — just search YouTube for tutorials
  app.post('/atlas/learn/find-videos', async (req, res) => {
    const { topic, count } = req.body || {};
    if (!topic) return res.status(400).json({ error: 'topic is required' });

    const result = await youtube.findTutorialVideos(topic, { count: count || 5 });
    res.json(result);
  });

  // POST /atlas/learn/extract — extract content from a specific video URL
  app.post('/atlas/learn/extract', async (req, res) => {
    const { videoUrl } = req.body || {};
    if (!videoUrl) return res.status(400).json({ error: 'videoUrl is required' });

    const result = await youtube.extractVideoContent(videoUrl);
    res.json(result);
  });

  // POST /atlas/learn/to-steps — convert extracted content to tutorial steps
  app.post('/atlas/learn/to-steps', async (req, res) => {
    const { content, targetApp } = req.body || {};
    if (!content) return res.status(400).json({ error: 'content is required' });

    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const result = await youtube.convertToTutorialSteps(content, targetApp || 'the application', BRAIN_URL, token);
    res.json(result);
  });

  // POST /atlas/learn/transcript — extract just the transcript (fast, no TinyFish metadata)
  app.post('/atlas/learn/transcript', async (req, res) => {
    const { videoUrl, lang } = req.body || {};
    if (!videoUrl) return res.status(400).json({ error: 'videoUrl is required' });

    const result = await youtube.extractTranscript(videoUrl, { lang });
    res.json(result);
  });

  console.log('[atlas-web] Routes mounted: /atlas/{dispatch,search,fetch,web-task,search-howto,tinyfish-status,learn,learn/*,learn/transcript}');
}

module.exports = {
  mountRoutes,
  dispatch,
  classifyTask,
  searchHowTo,
  executeWebTask,
  fetchPage,
};
