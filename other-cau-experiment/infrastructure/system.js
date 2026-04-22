const { execCommand } = require('./terminal');
const path = require('path');
const fs = require('fs/promises');

const SCREENSHOTS_DIR = path.join(process.env.HOME, '.capy-bridge', 'screenshots');

// Take a macOS screenshot
async function screenshot(options = {}) {
  await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
  const filename = `macos_screenshot_${Date.now()}.png`;
  const filepath = path.join(SCREENSHOTS_DIR, filename);

  // macOS screencapture command
  const flags = options.window ? '-w' : '';
  await execCommand(`screencapture ${flags} -x "${filepath}"`);

  return { path: filepath };
}

// Read clipboard
async function clipboardRead() {
  const result = await execCommand('pbpaste');
  return { content: result.stdout };
}

// Write to clipboard
async function clipboardWrite(text) {
  // Use stdin pipe to avoid any shell injection
  const { execSync } = require('child_process');
  execSync('pbcopy', { input: text, timeout: 5000 });
  return { written: true };
}

// Send macOS notification
async function notify(title, message) {
  const t = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, '');
  const m = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, '');
  await execCommand(
    `osascript -e 'display notification "${m}" with title "${t}"'`
  );
  return { sent: true, title, message };
}

// Get system info
async function systemInfo() {
  const [hostname, whoami, uptime, memory, disk] = await Promise.all([
    execCommand('hostname'),
    execCommand('whoami'),
    execCommand('uptime'),
    execCommand('vm_stat | head -5'),
    execCommand('df -h / | tail -1'),
  ]);

  return {
    hostname: hostname.stdout,
    user: whoami.stdout,
    uptime: uptime.stdout.trim(),
    memory: memory.stdout,
    disk: disk.stdout,
  };
}

// Open a file or URL with default app
async function open(target) {
  // Validate target doesn't contain shell metacharacters
  if (/[;&|`$()]/.test(target)) {
    throw new Error('Invalid target: contains shell metacharacters');
  }
  await execCommand(`open "${target.replace(/"/g, '\\"')}"`);
  return { opened: target };
}

// Get running processes (top 20 by CPU)
async function processes() {
  const result = await execCommand('ps aux --sort=-%cpu | head -21');
  return { output: result.stdout };
}

// Get active window info
async function activeWindow() {
  const result = await execCommand(
    `osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`
  );
  return { app: result.stdout.trim() };
}

module.exports = {
  screenshot, clipboardRead, clipboardWrite,
  notify, systemInfo, open, processes, activeWindow,
};
