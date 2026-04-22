const crypto = require('crypto');

// Generate a secure API token
function generateToken() {
  return 'capy_' + crypto.randomBytes(32).toString('hex');
}

// Auth middleware - checks Bearer token
function authMiddleware(req, res, next) {
  const token = process.env.CAPY_BRIDGE_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'Server token not configured' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const provided = authHeader.slice(7);
  // BUG-02 FIX: timingSafeEqual requires equal-length buffers.
  // Check length first (length comparison is not timing-sensitive since
  // an attacker already knows their own token length).
  const providedBuf = Buffer.from(provided);
  const tokenBuf = Buffer.from(token);
  if (providedBuf.length !== tokenBuf.length || !crypto.timingSafeEqual(providedBuf, tokenBuf)) {
    return res.status(403).json({ error: 'Invalid token' });
  }

  next();
}

// Auth for WebSocket connections (token in query param)
function authWebSocket(req) {
  const token = process.env.CAPY_BRIDGE_TOKEN;
  if (!token) return false;

  const url = new URL(req.url, `http://${req.headers.host}`);
  const provided = url.searchParams.get('token');
  if (!provided) return false;

  try {
    const providedBuf = Buffer.from(provided);
    const tokenBuf = Buffer.from(token);
    if (providedBuf.length !== tokenBuf.length) return false;
    return crypto.timingSafeEqual(providedBuf, tokenBuf);
  } catch {
    return false;
  }
}

module.exports = { generateToken, authMiddleware, authWebSocket };