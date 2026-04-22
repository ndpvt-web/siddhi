const { spawn } = require('child_process');
const path = require('path');

// Dangerous command patterns to block
const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\/(?!\w)/,       // rm -rf / (root)
  /mkfs\./,                     // format disk
  /dd\s+if=.*of=\/dev/,        // raw disk write
  /:(){ :\|:& };:/,            // fork bomb
  />\s*\/dev\/sda/,            // overwrite disk
];

function isBlocked(command) {
  return BLOCKED_PATTERNS.some(pattern => pattern.test(command));
}

// Execute a shell command and return output
function execCommand(command, options = {}) {
  return new Promise((resolve, reject) => {
    if (isBlocked(command)) {
      return reject(new Error('Command blocked for safety'));
    }

    const cwd = options.cwd || process.env.HOME;
    const timeout = options.timeout || 120000; // 2 min default

    const child = spawn('/bin/zsh', ['-l', '-c', command], {
      cwd,
      env: { ...process.env, ...options.env },
    });

    // Manual timeout enforcement (spawn doesn't support timeout option)
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2000);
    }, timeout);

    let stdout = '';
    let stderr = '';
    const MAX_OUTPUT = 10 * 1024 * 1024; // 10MB
    let stdoutTruncated = false;
    let stderrTruncated = false;

    child.stdout.on('data', (data) => {
      if (stdout.length < MAX_OUTPUT) {
        stdout += data.toString();
      } else if (!stdoutTruncated) {
        stdoutTruncated = true;
        stdout += '\n[output truncated at 10MB]';
      }
    });

    child.stderr.on('data', (data) => {
      if (stderr.length < MAX_OUTPUT) {
        stderr += data.toString();
      } else if (!stderrTruncated) {
        stderrTruncated = true;
        stderr += '\n[output truncated at 10MB]';
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

// Execute command with streaming (returns child process)
function execStreaming(command, options = {}) {
  if (isBlocked(command)) {
    throw new Error('Command blocked for safety');
  }

  const cwd = options.cwd || process.env.HOME;

  return spawn('/bin/zsh', ['-l', '-c', command], {
    cwd,
    env: { ...process.env, ...options.env },
  });
}

module.exports = { execCommand, execStreaming, isBlocked };
