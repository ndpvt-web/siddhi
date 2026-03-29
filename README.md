<div align="center">

# ATLAS
## The World's First Self-Evolving Desktop Computer-Use Agent.

### Autonomous Task Learning and Adaptive Strategy

It sees your screen. It clicks, types, and navigates. And unlike every other agent --
<br/>
*it remembers what worked, learns from what didn't, and gets better every time it runs.*

**Nivesh Dandyan** &middot; [LinkedIn](https://www.linkedin.com/in/nivesh-dandyan/) &middot; [@ndpvt-web](https://github.com/ndpvt-web)
<br/>
JC STEM Lab of Cyber Security, The University of Hong Kong

</div>

<p align="center">
  <img src="https://img.shields.io/badge/macOS-Desktop%20Agent-000000?style=for-the-badge&logo=apple&logoColor=white" />
  <img src="https://img.shields.io/badge/Runtime-Self--Evolving-blueviolet?style=for-the-badge" />
  <img src="https://img.shields.io/badge/Learning-Zero%20Retraining-success?style=for-the-badge" />
  <img src="https://img.shields.io/badge/Modules-41-blue?style=for-the-badge" />
  <img src="https://img.shields.io/badge/Tools-45+-orange?style=for-the-badge" />
</p>

---

Every computer-use agent today -- Anthropic CUA, OpenAI Operator, Google Mariner -- starts from a blank slate every session. They burn the same tokens re-discovering the same workflows, paying the same cost, making the same mistakes. **ATLAS breaks this cycle.** It is a fully autonomous macOS desktop agent that watches itself work, extracts patterns from its own behavior, graduates successful patterns into reusable strategies, and even forges entirely new tools from repeated workflows -- all at runtime, stored as inspectable JSON, with **zero model fine-tuning**. After just a few tasks, ATLAS completes familiar workflows in 2 iterations instead of 8, at 1/14th the cost, in 1/3rd the time. It doesn't just use your computer. It masters it.

This is not a research prototype running on synthetic benchmarks. ATLAS operates on a real macOS desktop -- launching apps, navigating Safari, composing emails, managing files -- with a hybrid vision system that combines the macOS Accessibility API (300ms, exact coordinates) with a 2B-parameter vision model (500ms, pixel-level grounding) for elements that accessibility can't see. When something goes wrong, it detects the surprise, escalates its reasoning model from Sonnet to Opus, and falls back to AppleScript if direct interaction fails. When it succeeds, it captures the trajectory and feeds it into a three-layer learning pipeline inspired by Aristotle's concept of **Phronesis** -- practical wisdom acquired through experience.

---

## How It Learns: The Phronesis Pipeline

Most agents are stateless. ATLAS has a memory that compounds.

```
                    +---------------------------+
                    |     Task Completed         |
                    | (success OR failure)       |
                    +-------------+-------------+
                                  |
                                  v
                 +----------------+----------------+
                 |        LAYER 1: REFLECTIONS      |
                 |  Post-mortem of every task:       |
                 |  tools used, iterations, cost,    |
                 |  outcome, error recovery steps    |
                 +----------------+----------------+
                                  |
                          every N tasks
                                  |
                                  v
                 +----------------+----------------+
                 |        LAYER 2: PATTERNS          |
                 |  Recurring tool-call sequences     |
                 |  detected across task types:       |
                 |  "screenshot -> AX -> click ->     |
                 |   type URL -> Return" = pattern    |
                 +----------------+----------------+
                                  |
                        graduation check
                    count >= median(all_counts)
                    success >= mean(all_rates)
                                  |
                                  v
                 +----------------+----------------+
                 |        LAYER 3: STRATEGIES         |
                 |  Battle-tested plans injected      |
                 |  into the system prompt BEFORE     |
                 |  the next task begins.             |
                 +----------------+----------------+
                                  |
                                  v
                       Next task starts faster,
                       cheaper, and more reliable.
```

The graduation thresholds are **data-adaptive** -- they rise as the system accumulates more evidence, preventing premature promotion while ensuring genuine expertise is captured. No magic numbers. No hyperparameters. The data decides.

---

## Production Learning Data

These numbers are from real deployment on a MacBook Pro M1, not benchmarks.

| Metric | Value |
|--------|-------|
| Total reflections captured | **110+** (ATLAS) &nbsp; **15+** (Brain) |
| Patterns extracted | **14** across 8 of 15 task categories |
| Average pattern success rate | **78.3%** |
| Graduated strategies | **2** (100% success, auto-promoted) |
| Keyboard shortcuts learned | **14** |
| Environment entities mapped | **11** (Safari 29x, TextEdit 13x, Notes, Finder...) |

### Graduated Strategies (real)

**`system_info_mac_system`** -- First strategy to graduate. After 3 identical system-info tasks all succeeded, the pipeline promoted the tool sequence into a strategy. Result: **5x cost reduction**, **6x latency improvement**.

**`vision_take_screenshot_screen_analyze`** -- Vision analysis tasks graduated after 3 occurrences at 100% success. Even when the cost didn't drop (vision is inherently expensive), the strategy **calibrated the agent's expectations**, eliminating unnecessary retry loops.

### Before & After Learning

| Task | Before (naive) | After (experienced) | Improvement |
|------|----------------|---------------------|-------------|
| "Open google.com" in Safari | 8 iterations, $1.17, 49s | 2 iterations, $0.08, 17s | **14.6x cheaper** |
| Morning briefing (mail + calendar + reminders) | 7 tools, $0.18 | 5 tools, $0.11 | **39% cheaper** |
| Battery + conditional reminder | 4 iterations, $0.15 | 2 iterations, $0.076 | **2x faster** |
| Screen analysis | First-time probe, $0.12 | 2 iterations, $0.07 | **42% cheaper** |

---

## Cross-Module Experience Transfer

ATLAS doesn't keep its knowledge to itself. A general-purpose **Brain** orchestrator can query ATLAS's learning store via HTTP before starting any desktop task:

```
Brain receives: "open google.com"
  |
  +-- Brain classifies as desktop task (keyword match)
  |
  +-- Brain calls POST /learning/context
  |     -> ATLAS returns: strategy for safari-navigate
  |     -> 14 keyboard shortcuts, 11 environment entities
  |
  +-- Brain injects context into system prompt
  |
  +-- Brain delegates to ATLAS with pre-loaded experience
  |
  Result: 2 iterations instead of 8. $0.08 instead of $1.17.
```

This is **not RAG** -- there are no human-authored documents being retrieved. The context is machine-generated episodic memory from the agent's own past successes and failures. The agent retrieves its own experience.

---

## Hybrid Vision Grounding

ATLAS uses a two-tier grounding system to locate UI elements on screen:

| Tier | Method | Latency | What It Sees |
|------|--------|---------|--------------|
| **Primary** | macOS AX API via `capy-ax` (custom Swift binary) | ~300ms | Buttons, text fields, menus, labels -- anything in the accessibility tree |
| **Fallback** | ShowUI-2B (MLX-quantized Qwen2-VL) | ~500ms | Images, custom web UI, canvas elements, icons -- anything visible on screen |

**Post-correction snap**: After every click, coordinates are snapped to the nearest AX element within a 60px radius. This corrects vision model imprecision using the accessibility tree as ground truth.

**TCC Routing**: macOS Transparency, Consent, and Control blocks direct keyboard input from background processes. ATLAS routes keyboard commands through a persistent Terminal.app daemon that holds the necessary TCC grants -- invisible to the user, zero-latency overhead.

---

## Architecture

```
server.js                          Express server (port 7888)
|
+-- modules/
|   +-- computer-use.js            ATLAS agent core (~2800 lines)
|   |                              Screenshot loop, OPAR cycle, escalation,
|   |                              AppleScript fallback, trajectory capture
|   +-- learning.js                3-layer Phronesis pipeline
|   +-- ax-grounding.js            Hybrid AX + ShowUI coordinate grounding
|   +-- input-bridge.js            Keyboard routing through TCC daemon
|   +-- trajectory.js              Task trajectory capture and replay
|   +-- cross-app-workflow.js      Multi-application coordination
|   +-- macro-recorder.js          Workflow recording and playback
|   |
|   +-- brain.js                   General orchestrator (~2050 lines)
|   |                              ContextBuilder, ToolExecutor, BrainOrchestrator
|   +-- brain-learning.js          Brain-level Phronesis (separate store)
|   +-- brain-tool-forge.js        LLM-generated tool creation (max 50)
|   +-- brain-macos-bridge.js      macOS app control (Mail, Calendar, etc.)
|   +-- brain-agents.js            Multi-agent delegation (5 profiles)
|   +-- brain-scheduler.js         Cron/interval task scheduling
|   +-- brain-proactive-memory.js  Predictive memory retrieval
|   +-- brain-memory.js            SQLite + FTS5 long-term memory
|   +-- brain-heartbeat.js         System health monitoring
|   |
|   +-- 22 additional modules      (see modules/ directory)
|
+-- showui-worker.py               ShowUI-2B persistent vision process
+-- capy-ax-helper.sh              AX accessibility routing
+-- capy-screenshot.sh             Screenshot daemon (TCC-aware)
+-- brain/IDENTITY.md              Aristotelian reasoning framework
```

**41 modules. 45+ tool schemas. 15,000+ lines. One self-improving system.**

---

## How ATLAS Compares

| Capability | ATLAS | Anthropic CUA | OpenAI Operator | Google Mariner | UFO2 | OpenSpace |
|:-----------|:-----:|:-------------:|:---------------:|:--------------:|:----:|:---------:|
| Desktop OS agent | Yes | Yes | Yes | Yes | Yes | No |
| Runtime learning (no retraining) | **Yes** | No | No | No | No | Yes |
| Cross-task pattern detection | **Yes** | No | No | No | No | Yes |
| Data-adaptive graduation | **Yes** | No | No | No | No | No |
| Tool self-creation | **Yes** | No | No | No | No | Yes |
| Hybrid AX + vision grounding | **Yes** | No | No | No | No | No |
| Experience transfer across modules | **Yes** | No | No | No | No | No |
| Escalation (Sonnet -> Opus) | **Yes** | N/A | N/A | N/A | No | No |

OpenSpace (HKUDS, 2025) pioneered self-evolving skills for coding agents. ATLAS brings that paradigm to **real desktop computer use** -- where the agent must see pixels, click coordinates, and navigate a GUI that changes with every action.

---

## Requirements

- macOS 15+ (tested on macOS 26.x, Apple Silicon)
- Node.js 18+
- Python 3.10+ with MLX (for ShowUI-2B vision model)
- Accessibility permissions granted to Terminal.app
- Claude API access (Sonnet 4.6 default, Opus 4.6 for escalation)

## Quick Start

```bash
git clone https://github.com/ndpvt-web/atlas.git
cd atlas
npm install
# Configure .env with your API keys
npm start
```

---

## Development

Built March 2026. From first screenshot capture to graduated strategies in 18 days.

| Date | Milestone |
|------|-----------|
| Mar 8-10 | Computer-use agent core: screenshot loop, action execution |
| Mar 10 | ShowUI-2B vision grounding integration |
| Mar 11 | AX hybrid grounding, Phronesis pipeline, Brain-ATLAS bridge |
| Mar 14-16 | Trajectory system, macro recording, cross-app workflows |
| Mar 17-18 | Input Bridge (TCC keyboard fix), efficiency optimizations |
| Mar 25 | Public repository |

---

<p align="center">
  <sub>ATLAS: because an agent that forgets everything it learned is just an expensive screenshot viewer.</sub>
</p>
