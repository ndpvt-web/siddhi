/**
 * brain-macos-bridge.js - Deep macOS System Integration for Jarvis Brain
 *
 * ARISTOTELIAN FIRST PRINCIPLES:
 * Axiom: A personal AI's value = depth of integration with user's environment
 * Deduction: macOS provides structured APIs (Accessibility, JXA, AppleScript)
 *   that are FASTER, MORE RELIABLE, and WORK WITHOUT DISPLAY than vision-only.
 * Conclusion: Dual-modality (structured API + vision fallback) is strictly superior.
 *
 * Capabilities:
 * 1. Accessibility Bridge - AXUIElement queries via JXA (5ms per query)
 * 2. Native App Tools - Reminders, Calendar, Notes, Mail, Contacts, Finder
 * 3. System Integration - Display wake, clipboard, notifications, volume, WiFi
 * 4. App Control - Open, close, switch, list running apps
 */

const { execSync, exec } = require('child_process');
const path = require('path');

// ============================================================================
// HELPERS
// ============================================================================

function runAppleScript(script, timeout = 10000) {
  try {
    const result = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      timeout,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    return { success: true, output: result.trim() };
  } catch (err) {
    return { success: false, error: err.message.split('\n')[0] };
  }
}

function runJXA(code, timeout = 10000) {
  try {
    const result = execSync(`osascript -l JavaScript -e '${code.replace(/'/g, "'\\''")}'`, {
      timeout,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    return { success: true, output: result.trim() };
  } catch (err) {
    return { success: false, error: err.message.split('\n')[0] };
  }
}

// Run longer scripts via temp file (avoids shell escaping)
function runAppleScriptFile(script, timeout = 15000) {
  const fs = require('fs');
  const tmpFile = `/tmp/capy-as-${Date.now()}.scpt`;
  try {
    fs.writeFileSync(tmpFile, script);
    const result = execSync(`osascript "${tmpFile}"`, {
      timeout,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    try { fs.unlinkSync(tmpFile); } catch (e) {}
    return { success: true, output: result.trim() };
  } catch (err) {
    try { require('fs').unlinkSync(tmpFile); } catch (e) {}
    return { success: false, error: err.message.split('\n')[0] };
  }
}

// PATCHED: Run JXA via temp file -- the -e approach breaks on complex scripts
// with nested quotes ('AXButton', 'AXLink', etc.)
function runJXAFile(code, timeout = 15000) {
  const fs = require('fs');
  const tmpFile = `/tmp/capy-jxa-${Date.now()}.js`;
  try {
    fs.writeFileSync(tmpFile, code);
    const result = execSync(`osascript -l JavaScript "${tmpFile}"`, {
      timeout,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    try { fs.unlinkSync(tmpFile); } catch (e) {}
    return { success: true, output: result.trim() };
  } catch (err) {
    try { require('fs').unlinkSync(tmpFile); } catch (e) {}
    return { success: false, error: err.message.split('\n')[0] };
  }
}

// ============================================================================
// 1. ACCESSIBILITY BRIDGE
// ============================================================================

/**
 * Get the accessibility tree of the frontmost app
 * Returns: button labels, text fields, menus, etc.
 * This works even when the display is off!
 */
function getAccessibilityTree(maxDepth = 3) {
  // PATCHED: Use native capy-ax binary via Terminal.app daemon
  try {
    const result = execSync(`"/Users/nivesh/Projects/atlas-copy/capy-ax-helper.sh" tree ${maxDepth}`, {
      timeout: 15000,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    return { success: true, output: result.trim() };
  } catch (err) {
    return { success: false, error: err.message.split('\n')[0] };
  }
}

/**
 * Get clickable elements in the frontmost app
 * Returns: list of buttons, links, menu items with positions
 */
function getClickableElements() {
  // PATCHED: Use native capy-ax binary via Terminal.app daemon
  try {
    const result = execSync('"/Users/nivesh/Projects/atlas-copy/capy-ax-helper.sh" clickable', {
      timeout: 15000,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    return { success: true, output: result.trim() };
  } catch (err) {
    return { success: false, error: err.message.split('\n')[0] };
  }
}

/**
 * Get text content of all visible text fields
 */
function getTextFields() {
  // PATCHED: Use native capy-ax binary via Terminal.app daemon
  try {
    const result = execSync('"/Users/nivesh/Projects/atlas-copy/capy-ax-helper.sh" text-fields', {
      timeout: 10000,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    return { success: true, output: result.trim() };
  } catch (err) {
    return { success: false, error: err.message.split('\n')[0] };
  }
}

/**
 * Click a UI element by accessibility label/title
 */
function accessibilityClick(targetTitle, targetRole) {
  // PATCHED: Use native capy-ax binary via Terminal.app daemon
  try {
    const args = targetRole ? `click "${targetTitle}" "${targetRole}"` : `click "${targetTitle}"`;
    const result = execSync(`"/Users/nivesh/Projects/atlas-copy/capy-ax-helper.sh" ${args}`, {
      timeout: 10000,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    return { success: true, output: result.trim() };
  } catch (err) {
    return { success: false, error: err.message.split('\n')[0] };
  }
}


// ============================================================================
// 2. NATIVE MAC APP TOOLS
// ============================================================================

// --- REMINDERS ---

function getReminders(listName) {
  const listFilter = listName
    ? `set targetList to list "${listName}" of default account`
    : `set targetList to first list of default account`;

  const script = `
tell application "Reminders"
  ${listFilter}
  set output to ""
  repeat with r in (reminders of targetList whose completed is false)
    set rName to name of r
    set rDue to ""
    try
      set rDue to due date of r as string
    end try
    set rPrio to priority of r as string
    set rBody to ""
    try
      set rBody to body of r
    end try
    set output to output & rName & " | " & rDue & " | " & rPrio & " | " & rBody & "\\n"
  end repeat
  return output
end tell`;
  return runAppleScriptFile(script);
}

function createReminder(title, dueDate, listName, notes, priority) {
  const listPart = listName
    ? `set targetList to list "${listName}" of default account`
    : `set targetList to first list of default account`;

  let props = `{name:"${title.replace(/"/g, '\\"')}"`;
  if (notes) props += `, body:"${notes.replace(/"/g, '\\"')}"`;
  if (priority) props += `, priority:${priority}`;
  props += `}`;

  let duePart = '';
  if (dueDate) {
    duePart = `set due date of newReminder to date "${dueDate}"`;
  }

  const script = `
tell application "Reminders"
  ${listPart}
  set newReminder to make new reminder at targetList with properties ${props}
  ${duePart}
  return "Created: " & name of newReminder
end tell`;
  return runAppleScriptFile(script);
}

function completeReminder(title) {
  const script = `
tell application "Reminders"
  set targetReminders to (reminders whose name contains "${title.replace(/"/g, '\\"')}" and completed is false)
  if (count of targetReminders) > 0 then
    set completed of item 1 of targetReminders to true
    return "Completed: " & name of item 1 of targetReminders
  else
    return "Not found: ${title.replace(/"/g, '\\"')}"
  end if
end tell`;
  return runAppleScriptFile(script);
}

function getReminderLists() {
  const script = `
tell application "Reminders"
  set output to ""
  repeat with l in lists of default account
    set lName to name of l
    set lCount to count of (reminders of l whose completed is false)
    set output to output & lName & " (" & lCount & " active)\\n"
  end repeat
  return output
end tell`;
  return runAppleScriptFile(script);
}

// --- NOTES ---

function searchNotes(query) {
  const script = `
tell application "Notes"
  set matchedNotes to notes whose name contains "${query.replace(/"/g, '\\"')}"
  set output to ""
  repeat with n in matchedNotes
    if (count of output) < 5000 then
      set output to output & "## " & name of n & "\\n"
      set output to output & (plaintext of n) & "\\n---\\n"
    end if
  end repeat
  if output is "" then return "No notes found matching: ${query.replace(/"/g, '\\"')}"
  return output
end tell`;
  return runAppleScriptFile(script);
}

function createNote(title, body, folderName) {
  const folderPart = folderName
    ? `set targetFolder to folder "${folderName}"
    make new note at targetFolder with properties {name:"${title.replace(/"/g, '\\"')}", body:"${(body || '').replace(/"/g, '\\"')}"}`
    : `make new note with properties {name:"${title.replace(/"/g, '\\"')}", body:"${(body || '').replace(/"/g, '\\"')}"}`;

  const script = `
tell application "Notes"
  ${folderPart}
  return "Created note: ${title.replace(/"/g, '\\"')}"
end tell`;
  return runAppleScriptFile(script);
}

function getNoteFolders() {
  const script = `
tell application "Notes"
  set output to ""
  repeat with f in folders
    set fName to name of f
    set fCount to count of notes of f
    set output to output & fName & " (" & fCount & " notes)\\n"
  end repeat
  return output
end tell`;
  return runAppleScriptFile(script);
}

// --- CALENDAR ---

function getCalendarEvents(daysAhead) {
  const days = daysAhead || 1;
  const script = `
set startDate to current date
set endDate to startDate + (${days} * days)
set output to ""
tell application "Calendar"
  repeat with cal in calendars
    set calEvents to (events of cal whose start date >= startDate and start date <= endDate)
    repeat with e in calEvents
      set eName to summary of e
      set eStart to start date of e as string
      set eEnd to end date of e as string
      set eLoc to ""
      try
        set eLoc to location of e
      end try
      set eNotes to ""
      try
        set eNotes to description of e
      end try
      set output to output & eName & " | " & eStart & " - " & eEnd & " | " & eLoc & " | " & eNotes & "\\n"
    end repeat
  end repeat
  if output is "" then return "No events in the next ${days} day(s)."
  return output
end tell`;
  return runAppleScriptFile(script);
}

function createCalendarEvent(title, startDate, endDate, calendar, location, notes) {
  const calPart = calendar
    ? `set targetCal to calendar "${calendar}"`
    : `set targetCal to first calendar whose name is not ""`;

  const script = `
tell application "Calendar"
  ${calPart}
  set newEvent to make new event at end of events of targetCal with properties {summary:"${title.replace(/"/g, '\\"')}", start date:date "${startDate}", end date:date "${endDate || startDate}"}
  ${location ? `set location of newEvent to "${location.replace(/"/g, '\\"')}"` : ''}
  ${notes ? `set description of newEvent to "${notes.replace(/"/g, '\\"')}"` : ''}
  return "Created event: ${title.replace(/"/g, '\\"')}"
end tell`;
  return runAppleScriptFile(script);
}

// --- MAIL ---

function getUnreadMail(count) {
  const limit = count || 5;
  const script = `
tell application "Mail"
  set unread to messages of inbox whose read status is false
  set output to ""
  set i to 0
  repeat with m in unread
    if i >= ${limit} then exit repeat
    set mSubject to subject of m
    set mSender to sender of m
    set mDate to date received of m as string
    set mExcerpt to "(no preview)"
    try
      set mContent to content of m
      if length of mContent > 200 then
        set mExcerpt to text 1 thru 200 of mContent
      else
        set mExcerpt to mContent
      end if
    end try
    set output to output & "From: " & mSender & "\\nSubject: " & mSubject & "\\nDate: " & mDate & "\\nExcerpt: " & mExcerpt & "\\n---\\n"
    set i to i + 1
  end repeat
  if output is "" then return "No unread emails."
  return output
end tell`;
  return runAppleScriptFile(script, 20000);
}

// --- CONTACTS ---

function searchContacts(query) {
  const script = `
tell application "Contacts"
  set matches to people whose name contains "${query.replace(/"/g, '\\"')}"
  set output to ""
  repeat with p in matches
    set pName to name of p
    set pEmail to ""
    try
      set pEmail to value of first email of p
    end try
    set pPhone to ""
    try
      set pPhone to value of first phone of p
    end try
    set output to output & pName & " | " & pEmail & " | " & pPhone & "\\n"
  end repeat
  if output is "" then return "No contacts found matching: ${query.replace(/"/g, '\\"')}"
  return output
end tell`;
  return runAppleScriptFile(script);
}

// --- FINDER ---

function getFinderSelection() {
  const result = runAppleScript('tell application "Finder" to get selection as alias list');
  return result;
}

function getRecentFiles(count) {
  const limit = count || 10;
  const script = `do shell script "mdfind -onlyin ~ 'kMDItemContentModificationDate >= $time.today(-1)' | head -${limit}"`;
  return runAppleScript(script);
}

// --- MUSIC ---

function getMusicStatus() {
  const script = `
tell application "Music"
  if player state is playing then
    set trackName to name of current track
    set artistName to artist of current track
    set albumName to album of current track
    set pos to player position as integer
    set dur to duration of current track as integer
    return "Playing: " & trackName & " by " & artistName & " (" & albumName & ") " & pos & "s / " & dur & "s"
  else
    return "Music is " & (player state as string)
  end if
end tell`;
  return runAppleScript(script);
}

function musicControl(action) {
  const commands = {
    play: 'play',
    pause: 'pause',
    next: 'next track',
    previous: 'previous track',
    'volume_up': 'set sound volume to (sound volume + 10)',
    'volume_down': 'set sound volume to (sound volume - 10)',
  };
  const cmd = commands[action] || action;
  return runAppleScript(`tell application "Music" to ${cmd}`);
}

// --- SYSTEM ---

function wakeDisplay() {
  try {
    execSync('caffeinate -u -t 3', { timeout: 5000 });
    return { success: true, output: 'Display wake signal sent' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function getWifiStatus() {
  try {
    const result = execSync(
      'networksetup -getairportnetwork en0 2>/dev/null || networksetup -getairportnetwork en1 2>/dev/null',
      { timeout: 5000, encoding: 'utf8' }
    );
    return { success: true, output: result.trim() };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function getBatteryStatus() {
  try {
    const result = execSync('pmset -g batt', { timeout: 5000, encoding: 'utf8' });
    return { success: true, output: result.trim() };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function getVolumeLevel() {
  try {
    const result = execSync('osascript -e "output volume of (get volume settings)"', { timeout: 5000, encoding: 'utf8' });
    return { success: true, output: `Volume: ${result.trim()}%` };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function setVolume(level) {
  try {
    execSync(`osascript -e 'set volume output volume ${Math.min(100, Math.max(0, level))}'`, { timeout: 5000 });
    return { success: true, output: `Volume set to ${level}%` };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function getDiskSpace() {
  try {
    const result = execSync('df -h / | tail -1', { timeout: 5000, encoding: 'utf8' });
    return { success: true, output: result.trim() };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function getRunningApps() {
  const result = runJXA(`
    const se = Application("System Events");
    const apps = se.processes.whose({backgroundOnly: false})();
    JSON.stringify(apps.map(a => ({name: a.name(), frontmost: a.frontmost()})));
  `);
  return result;
}

function switchToApp(appName) {
  return runAppleScript(`tell application "${appName}" to activate`);
}

function getActiveWindowTitle() {
  return runJXA(`
    const se = Application("System Events");
    const front = se.processes.whose({frontmost: true})[0];
    const wins = front.windows();
    JSON.stringify({app: front.name(), window: wins.length > 0 ? wins[0].title() : 'none', windowCount: wins.length});
  `);
}

// ============================================================================
// 3. EXPRESS ROUTES
// ============================================================================

function mountMacBridgeRoutes(app) {
  // --- Accessibility ---
  app.post('/mac/accessibility/tree', (req, res) => {
    const { maxDepth } = req.body || {};
    const result = getAccessibilityTree(maxDepth || 3);
    if (result.success) {
      try { res.json(JSON.parse(result.output)); }
      catch { res.json({ raw: result.output }); }
    } else {
      res.status(500).json({ error: result.error });
    }
  });

  app.post('/mac/accessibility/clickable', (req, res) => {
    const result = getClickableElements();
    if (result.success) {
      try { res.json(JSON.parse(result.output)); }
      catch { res.json({ raw: result.output }); }
    } else {
      res.status(500).json({ error: result.error });
    }
  });

  app.post('/mac/accessibility/text-fields', (req, res) => {
    const result = getTextFields();
    if (result.success) {
      try { res.json(JSON.parse(result.output)); }
      catch { res.json({ raw: result.output }); }
    } else {
      res.status(500).json({ error: result.error });
    }
  });

  app.post('/mac/accessibility/click', (req, res) => {
    const { title, role } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title required' });
    const result = accessibilityClick(title, role);
    if (result.success) {
      try { res.json(JSON.parse(result.output)); }
      catch { res.json({ raw: result.output }); }
    } else {
      res.status(500).json({ error: result.error });
    }
  });

  // --- Reminders ---
  app.post('/mac/reminders/list', (req, res) => {
    const { listName } = req.body || {};
    const result = getReminders(listName);
    res.json(result);
  });

  app.post('/mac/reminders/create', (req, res) => {
    const { title, dueDate, listName, notes, priority } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title required' });
    const result = createReminder(title, dueDate, listName, notes, priority);
    res.json(result);
  });

  app.post('/mac/reminders/complete', (req, res) => {
    const { title } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title required' });
    const result = completeReminder(title);
    res.json(result);
  });

  app.get('/mac/reminders/lists', (req, res) => {
    const result = getReminderLists();
    res.json(result);
  });

  // --- Notes ---
  app.post('/mac/notes/search', (req, res) => {
    const { query } = req.body || {};
    if (!query) return res.status(400).json({ error: 'query required' });
    const result = searchNotes(query);
    res.json(result);
  });

  app.post('/mac/notes/create', (req, res) => {
    const { title, body, folder } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title required' });
    const result = createNote(title, body, folder);
    res.json(result);
  });

  app.get('/mac/notes/folders', (req, res) => {
    const result = getNoteFolders();
    res.json(result);
  });

  // --- Calendar ---
  app.post('/mac/calendar/events', (req, res) => {
    const { daysAhead } = req.body || {};
    const result = getCalendarEvents(daysAhead);
    res.json(result);
  });

  app.post('/mac/calendar/create', (req, res) => {
    const { title, startDate, endDate, calendar, location, notes } = req.body || {};
    if (!title || !startDate) return res.status(400).json({ error: 'title and startDate required' });
    const result = createCalendarEvent(title, startDate, endDate, calendar, location, notes);
    res.json(result);
  });

  // --- Mail ---
  app.post('/mac/mail/unread', (req, res) => {
    const { count } = req.body || {};
    const result = getUnreadMail(count);
    res.json(result);
  });

  // --- Contacts ---
  app.post('/mac/contacts/search', (req, res) => {
    const { query } = req.body || {};
    if (!query) return res.status(400).json({ error: 'query required' });
    const result = searchContacts(query);
    res.json(result);
  });

  // --- Music ---
  app.get('/mac/music/status', (req, res) => {
    const result = getMusicStatus();
    res.json(result);
  });

  app.post('/mac/music/control', (req, res) => {
    const { action } = req.body || {};
    if (!action) return res.status(400).json({ error: 'action required (play/pause/next/previous/volume_up/volume_down)' });
    const result = musicControl(action);
    res.json(result);
  });

  // --- System ---
  app.post('/mac/system/wake-display', (req, res) => {
    const result = wakeDisplay();
    res.json(result);
  });

  app.get('/mac/system/battery', (req, res) => {
    const result = getBatteryStatus();
    res.json(result);
  });

  app.get('/mac/system/wifi', (req, res) => {
    const result = getWifiStatus();
    res.json(result);
  });

  app.get('/mac/system/volume', (req, res) => {
    const result = getVolumeLevel();
    res.json(result);
  });

  app.post('/mac/system/volume', (req, res) => {
    const { level } = req.body || {};
    if (level === undefined) return res.status(400).json({ error: 'level required (0-100)' });
    const result = setVolume(level);
    res.json(result);
  });

  app.get('/mac/system/disk', (req, res) => {
    const result = getDiskSpace();
    res.json(result);
  });

  app.get('/mac/system/apps', (req, res) => {
    const result = getRunningApps();
    if (result.success) {
      try { res.json({ apps: JSON.parse(result.output) }); }
      catch { res.json({ raw: result.output }); }
    } else {
      res.status(500).json({ error: result.error });
    }
  });

  app.post('/mac/system/switch-app', (req, res) => {
    const { app: appName } = req.body || {};
    if (!appName) return res.status(400).json({ error: 'app name required' });
    const result = switchToApp(appName);
    res.json(result);
  });

  app.get('/mac/system/active-window', (req, res) => {
    const result = getActiveWindowTitle();
    if (result.success) {
      try { res.json(JSON.parse(result.output)); }
      catch { res.json({ raw: result.output }); }
    } else {
      res.status(500).json({ error: result.error });
    }
  });

  // --- Finder ---
  app.get('/mac/finder/recent-files', (req, res) => {
    const { count } = req.query || {};
    const result = getRecentFiles(parseInt(count) || 10);
    res.json(result);
  });

  // --- Health ---
  app.get('/mac/health', (req, res) => {
    res.json({
      status: 'ok',
      module: 'brain-macos-bridge',
      capabilities: [
        'accessibility-tree', 'accessibility-click', 'clickable-elements', 'text-fields',
        'reminders-crud', 'notes-crud', 'calendar-crud', 'mail-read', 'contacts-search',
        'music-control', 'system-info', 'display-wake', 'app-switching',
        'battery', 'wifi', 'volume', 'disk', 'running-apps', 'finder'
      ],
    });
  });

  console.log('[MacBridge] Deep macOS integration mounted at /mac/* (accessibility + apps + system)');
}

// ============================================================================
// 4. BRAIN TOOL SCHEMAS
// ============================================================================

const MAC_BRIDGE_SCHEMAS = [
  {
    name: 'mac_accessibility',
    description: 'Query the macOS Accessibility API to get structured UI element data from the frontmost app. Returns buttons, text fields, menus with positions and labels. Works even when display is off. Use for precise UI interaction without screenshots.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['tree', 'clickable', 'text_fields', 'click'],
          description: 'tree: full UI tree, clickable: buttons/links/menus, text_fields: input fields, click: click by label',
        },
        title: {
          type: 'string',
          description: 'For click action: the title/label of the element to click.',
        },
        role: {
          type: 'string',
          description: 'For click action: optional role filter (Button, Link, MenuItem, etc.)',
        },
        max_depth: {
          type: 'number',
          description: 'For tree action: maximum depth to traverse (default 3).',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'mac_reminders',
    description: 'Interact with macOS Reminders app. Create, list, complete reminders. Access reminder lists.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'create', 'complete', 'lists'],
          description: 'list: get active reminders, create: new reminder, complete: mark done, lists: get all lists',
        },
        title: { type: 'string', description: 'Reminder title (for create/complete)' },
        due_date: { type: 'string', description: 'Due date string (e.g. "March 15, 2026 at 9:00 AM")' },
        list_name: { type: 'string', description: 'Reminder list name (optional)' },
        notes: { type: 'string', description: 'Additional notes (for create)' },
        priority: { type: 'number', description: 'Priority 0-9 (0=none, 1=high, 5=medium, 9=low)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'mac_notes',
    description: 'Interact with macOS Notes app. Search notes, create new notes, list folders.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'create', 'folders'],
          description: 'search: find notes by keyword, create: new note, folders: list all folders',
        },
        query: { type: 'string', description: 'Search query (for search action)' },
        title: { type: 'string', description: 'Note title (for create)' },
        body: { type: 'string', description: 'Note body text (for create)' },
        folder: { type: 'string', description: 'Target folder name (for create, optional)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'mac_calendar',
    description: 'Interact with macOS Calendar app. Get upcoming events, create new events.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['events', 'create'],
          description: 'events: get upcoming events, create: new calendar event',
        },
        days_ahead: { type: 'number', description: 'How many days ahead to look (default 1)' },
        title: { type: 'string', description: 'Event title (for create)' },
        start_date: { type: 'string', description: 'Start date (e.g. "March 15, 2026 at 2:00 PM")' },
        end_date: { type: 'string', description: 'End date (e.g. "March 15, 2026 at 3:00 PM")' },
        calendar: { type: 'string', description: 'Calendar name (optional)' },
        location: { type: 'string', description: 'Event location (optional)' },
        notes: { type: 'string', description: 'Event notes (optional)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'mac_mail',
    description: 'Read unread emails from macOS Mail app. Returns sender, subject, date, and excerpt.',
    input_schema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Number of unread emails to retrieve (default 5, max 20)' },
      },
    },
  },
  {
    name: 'mac_contacts',
    description: 'Search macOS Contacts by name. Returns name, email, phone number.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name to search for' },
      },
      required: ['query'],
    },
  },
  {
    name: 'mac_music',
    description: 'Control macOS Music app. Get current track info, play/pause/skip, adjust volume.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'play', 'pause', 'next', 'previous', 'volume_up', 'volume_down'],
          description: 'Music control action',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'mac_system',
    description: 'macOS system control: battery, WiFi, volume, disk space, running apps, switch apps, wake display, active window info.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['battery', 'wifi', 'volume', 'set_volume', 'disk', 'apps', 'switch_app', 'wake_display', 'active_window', 'recent_files'],
          description: 'System action to perform',
        },
        app_name: { type: 'string', description: 'App name (for switch_app)' },
        volume_level: { type: 'number', description: 'Volume 0-100 (for set_volume)' },
        count: { type: 'number', description: 'Number of items (for recent_files, default 10)' },
      },
      required: ['action'],
    },
  },
];

module.exports = {
  mountMacBridgeRoutes,
  MAC_BRIDGE_SCHEMAS,
  // Export individual functions for direct use
  getAccessibilityTree,
  getClickableElements,
  getTextFields,
  accessibilityClick,
  wakeDisplay,
  getRunningApps,
  switchToApp,
};