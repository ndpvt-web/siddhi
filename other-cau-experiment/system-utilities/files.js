const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execCommand } = require('./terminal');

// Ensure path is within allowed directories (home dir by default)
function validatePath(filePath) {
  const resolved = path.resolve(filePath);
  const home = process.env.HOME;
  // Allow access within home directory
  if (!resolved.startsWith(home) && !resolved.startsWith('/tmp')) {
    throw new Error(`Access denied: path must be within ${home} or /tmp`);
  }
  return resolved;
}

async function readFile(filePath, options = {}) {
  const resolved = validatePath(filePath);
  const encoding = options.encoding || 'utf-8';

  if (options.binary) {
    const buffer = await fsp.readFile(resolved);
    return { content: buffer.toString('base64'), encoding: 'base64', path: resolved };
  }

  const content = await fsp.readFile(resolved, encoding);
  return { content, encoding, path: resolved };
}

async function writeFile(filePath, content, options = {}) {
  const resolved = validatePath(filePath);

  // Create parent directories if needed
  await fsp.mkdir(path.dirname(resolved), { recursive: true });

  if (options.encoding === 'base64') {
    await fsp.writeFile(resolved, Buffer.from(content, 'base64'));
  } else {
    await fsp.writeFile(resolved, content, options.encoding || 'utf-8');
  }

  return { path: resolved, written: true };
}

async function listDir(dirPath, options = {}) {
  const resolved = validatePath(dirPath);
  const entries = await fsp.readdir(resolved, { withFileTypes: true });

  const results = entries.map(entry => ({
    name: entry.name,
    type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
    path: path.join(resolved, entry.name),
  }));

  if (options.details) {
    for (const item of results) {
      try {
        const stat = await fsp.stat(item.path);
        item.size = stat.size;
        item.modified = stat.mtime.toISOString();
      } catch {}
    }
  }

  return results;
}

async function deleteFile(filePath) {
  const resolved = validatePath(filePath);
  const stat = await fsp.stat(resolved);

  if (stat.isDirectory()) {
    await fsp.rm(resolved, { recursive: true });
  } else {
    await fsp.unlink(resolved);
  }

  return { path: resolved, deleted: true };
}

async function searchFiles(directory, pattern) {
  const resolved = validatePath(directory);
  // Use macOS find command
  const result = await execCommand(
    `find "${resolved}" -maxdepth 5 -name "${pattern}" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -100`
  );
  return result.stdout.split('\n').filter(Boolean);
}

async function grepFiles(directory, searchPattern, fileGlob = '*') {
  const resolved = validatePath(directory);
  const result = await execCommand(
    `grep -rl "${searchPattern}" "${resolved}" --include="${fileGlob}" 2>/dev/null | head -50`
  );
  return result.stdout.split('\n').filter(Boolean);
}

module.exports = { readFile, writeFile, listDir, deleteFile, searchFiles, grepFiles, validatePath };
