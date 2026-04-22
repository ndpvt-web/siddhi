'use strict';

/**
 * Atlas YouTube Learning Module
 *
 * Flow:
 *   1. User says "teach me CAD" or "learn Photoshop"
 *   2. TinyFish Agent browses YouTube, finds best tutorial video
 *   3. Direct transcript extraction via innertube API (fast, free)
 *      Falls back to TinyFish Agent for page content + transcript
 *   4. Brain LLM converts raw content into structured tutorial steps
 *   5. Steps feed into the Atlas tutorial engine for interactive guidance
 */

const tinyfish = require('./tinyfish');
const ytTranscript = require('./youtube-transcript');

// ─── Find Tutorial Videos ─────────────────────────────────────
// Uses TinyFish Agent to search YouTube and return top results

async function findTutorialVideos(topic, opts = {}) {
  const count = opts.count || 3;
  const goal = `Search YouTube for "${topic} tutorial for beginners". ` +
    `Return the top ${count} results as a JSON array with keys: ` +
    `title, url, channel, views, duration. Only include actual tutorial videos, not shorts or ads.`;

  const result = await tinyfish.runAgent('https://www.youtube.com', goal, {
    timeout: opts.timeout || 90000,
  });

  if (!result.ok) return result;

  // Normalize the result — Agent may return in different shapes
  let videos = [];
  const r = result.result;
  if (Array.isArray(r)) {
    videos = r;
  } else if (r && typeof r === 'object') {
    // Try known keys: videos, results, or any array with title fields
    videos = r.videos || r.results || [];
    if (!videos.length) {
      for (const val of Object.values(r)) {
        if (Array.isArray(val) && val.length > 0 && (val[0].title || val[0].video_title)) {
          videos = val;
          break;
        }
      }
    }
  }

  // Normalize video keys
  videos = videos.map(v => ({
    title: v.title || v.video_title || '',
    url: v.url || v.video_url || '',
    channel: v.channel || v.channel_name || '',
    views: v.views || v.view_count || '',
    duration: v.duration || '',
  }));

  return { ok: true, videos, raw: result.result };
}

// ─── Extract Video Content ────────────────────────────────────
// Two-phase extraction:
//   Phase A: Try direct transcript via innertube API (< 3 seconds)
//   Phase B: Use TinyFish Agent for page metadata (title, description, chapters)
// Transcript from Phase A is merged into Phase B's content.

async function extractVideoContent(videoUrl, opts = {}) {
  console.log(`[atlas-youtube] extractVideoContent: ${videoUrl}`);

  // Phase A: Fast transcript extraction (runs in parallel with Phase B)
  const transcriptPromise = ytTranscript.extractTranscript(videoUrl, {
    lang: opts.lang || 'en',
    skipTinyFish: opts.skipTranscriptTinyFish,
  });

  // Phase B: TinyFish Agent for metadata (title, description, chapters)
  const metaGoal = `Extract the video title, channel name, full description (click Show more), ` +
    `video duration, and all chapter timestamps with titles. ` +
    `Return as JSON with keys: title, channel, duration, description, chapters (array of {time, title}).`;

  const metaPromise = tinyfish.runAgent(videoUrl, metaGoal, {
    timeout: opts.timeout || 120000,
  });

  // Wait for both in parallel
  const [transcriptResult, metaResult] = await Promise.all([transcriptPromise, metaPromise]);

  // Build content from metadata
  let content;
  if (metaResult.ok) {
    const raw = metaResult.result || {};
    content = {
      title: raw.title || raw.video_title || '',
      channel: raw.channel || raw.channel_name || '',
      duration: raw.duration || raw.video_duration || '',
      description: raw.description || '',
      chapters: normalizeChapters(raw.chapters || raw.chapter_timestamps || []),
      transcript: [],
      hasTranscript: false,
    };
  } else {
    // Metadata extraction failed — use minimal content
    content = {
      title: '', channel: '', duration: '', description: '',
      chapters: [], transcript: [], hasTranscript: false,
    };
  }

  // Merge transcript from Phase A
  if (transcriptResult.ok && transcriptResult.transcript.length > 0) {
    content.transcript = transcriptResult.transcript.map(t => ({
      time: t.time,
      text: t.text,
    }));
    content.hasTranscript = true;
    content.transcriptSource = transcriptResult.source;
    console.log(`[atlas-youtube] Transcript: ${content.transcript.length} entries via ${transcriptResult.source}`);
  } else {
    console.log(`[atlas-youtube] No transcript available: ${transcriptResult.error || 'unknown'}`);
  }

  return { ok: true, content, url: videoUrl };
}

function normalizeChapters(chapters) {
  if (!Array.isArray(chapters)) return [];
  return chapters.map(c => ({
    time: c.time || c.timestamp || '',
    title: c.title || c.name || '',
  }));
}

function normalizeTranscript(transcript) {
  if (!transcript) return [];
  if (typeof transcript === 'string') return []; // "Not available" etc.
  if (!Array.isArray(transcript)) return [];
  return transcript.map(t => ({
    time: t.time || t.timestamp || '',
    text: t.text || t.content || '',
  }));
}

// ─── Extract Tutorial Steps from Video Content ────────────────
// Uses Brain LLM to convert raw video content into actionable desktop steps

async function convertToTutorialSteps(videoContent, targetApp, brainUrl, token) {
  const content = videoContent.content || videoContent;

  const prompt = `You are Atlas, a macOS desktop tutorial assistant. A user wants to learn "${targetApp}" by following a YouTube tutorial.

Here is the extracted content from the tutorial video:

TITLE: ${content.title || 'Unknown'}
CHANNEL: ${content.channel || 'Unknown'}
DURATION: ${content.duration || 'Unknown'}

DESCRIPTION:
${content.description || 'No description'}

CHAPTERS:
${(content.chapters || []).map(c => `${c.time} - ${c.title}`).join('\n') || 'No chapters'}

TRANSCRIPT:
${(content.transcript || []).map(t => `[${t.time}] ${t.text}`).join('\n').slice(0, 6000) || 'No transcript available'}

Based on this video content, generate a series of INTERACTIVE TUTORIAL STEPS that the user can follow on their actual macOS desktop. Each step should be a real action they perform in the app.

Format each step as:
N. action | targetDescription | expectedState | why | pitfall

Where:
- action: What the user does (e.g., "Click the File menu", "Press Cmd+N")
- targetDescription: What UI element to look for (e.g., "File menu in the menu bar")
- expectedState: What should happen after (e.g., "A new document window opens")
- why: Brief explanation from the video
- pitfall: Common mistake to avoid

Generate 5-10 concrete, actionable steps. Focus on the FIRST task from the video that can be done right now on the desktop. Skip intro/setup steps if the app is already installed.

Return ONLY the numbered steps, nothing else.`;

  try {
    const res = await fetch(brainUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ message: prompt, model: 'sonnet' }),
    });

    if (!res.ok) {
      return { ok: false, error: `Brain API HTTP ${res.status}` };
    }

    const data = await res.json();
    const stepsText = data?.data?.response || '';

    // Parse steps into structured format
    const steps = [];
    const lines = stepsText.split('\n').filter(l => /^\d+\./.test(l.trim()));
    for (const line of lines) {
      const match = line.match(/^\d+\.\s*(.+)/);
      if (!match) continue;
      const parts = match[1].split('|').map(s => s.trim());
      steps.push({
        action: parts[0] || '',
        targetDesc: parts[1] || '',
        expectedState: parts[2] || '',
        why: parts[3] || '',
        pitfall: parts[4] || '',
      });
    }

    return { ok: true, steps, raw: stepsText };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Full Pipeline: Topic → Interactive Tutorial ──────────────
// The main entry point: takes a topic, finds a video, extracts content,
// generates interactive steps

async function learnFromYouTube(topic, opts = {}) {
  const brainUrl = opts.brainUrl || 'http://localhost:7888/brain/query';
  const token = opts.token || '';

  console.log(`[atlas-youtube] Starting learn pipeline for: "${topic}"`);

  // Step 1: Find tutorial videos
  console.log('[atlas-youtube] Step 1: Finding tutorial videos...');
  const videosResult = await findTutorialVideos(topic, { count: 3 });
  if (!videosResult.ok || !videosResult.videos.length) {
    return { ok: false, stage: 'search', error: videosResult.error || 'No tutorial videos found' };
  }

  const selectedVideo = videosResult.videos[0];
  console.log(`[atlas-youtube] Found: "${selectedVideo.title}" (${selectedVideo.url})`);

  // Step 2: Extract video content
  console.log('[atlas-youtube] Step 2: Extracting video content...');
  const contentResult = await extractVideoContent(selectedVideo.url);
  if (!contentResult.ok) {
    return { ok: false, stage: 'extract', error: contentResult.error, video: selectedVideo };
  }

  console.log('[atlas-youtube] Content extracted successfully');

  // Step 3: Convert to tutorial steps
  console.log('[atlas-youtube] Step 3: Converting to interactive tutorial steps...');
  const targetApp = opts.targetApp || topic;
  const stepsResult = await convertToTutorialSteps(contentResult.content, targetApp, brainUrl, token);
  if (!stepsResult.ok) {
    return { ok: false, stage: 'convert', error: stepsResult.error, video: selectedVideo, content: contentResult.content };
  }

  console.log(`[atlas-youtube] Generated ${stepsResult.steps.length} interactive steps`);

  return {
    ok: true,
    video: selectedVideo,
    allVideos: videosResult.videos,
    content: contentResult.content,
    steps: stepsResult.steps,
    stepsRaw: stepsResult.raw,
  };
}

// ─── Quick Extract: Just get video content without tutorial conversion ──
async function quickExtract(videoUrl) {
  console.log(`[atlas-youtube] Quick extract: ${videoUrl}`);
  return extractVideoContent(videoUrl);
}

// ─── Direct Transcript Extraction ────────────────────────────────
// Exposed for callers that only need the transcript (no TinyFish metadata)
async function extractTranscript(videoUrl, opts) {
  return ytTranscript.extractTranscript(videoUrl, opts);
}

module.exports = {
  findTutorialVideos,
  extractVideoContent,
  extractTranscript,
  convertToTutorialSteps,
  learnFromYouTube,
  quickExtract,
};
