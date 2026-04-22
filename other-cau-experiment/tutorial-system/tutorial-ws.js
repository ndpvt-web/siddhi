'use strict';

/**
 * tutorial-ws.js
 * WebSocket layer for the Atlas Tutorial System.
 * Uses the battle-tested 'ws' npm package for full RFC 6455 compliance.
 */

const { WebSocketServer } = require('ws');

// ── Client wrapper ─────────────────────────────────────────────────────────

class WSClient {
  constructor(ws) {
    this.ws = ws;
    this.alive = true;
  }

  send(data) {
    if (!this.alive || this.ws.readyState !== 1) return false;
    try {
      const str = typeof data === 'string' ? data : JSON.stringify(data);
      this.ws.send(str);
      return true;
    } catch (err) {
      this.alive = false;
      return false;
    }
  }

  close(code) {
    this.alive = false;
    try { this.ws.close(code || 1000); } catch (_) {}
  }
}

// ── Upgrade handler ────────────────────────────────────────────────────────

let _wss = null;

function handleUpgrade(req, socket, head, expectedPath, onClient, onMessage, onClose) {
  const urlPath = req.url ? req.url.split('?')[0] : '';
  if (urlPath !== expectedPath) {
    socket.destroy();
    return;
  }

  if (!_wss) {
    _wss = new WebSocketServer({ noServer: true });
  }

  _wss.handleUpgrade(req, socket, head, (ws) => {
    const client = new WSClient(ws);

    ws.on('message', (data) => {
      try {
        const text = typeof data === 'string' ? data : data.toString('utf8');
        const msg = JSON.parse(text);
        onMessage(client, msg);
      } catch (err) {
        console.log(`[WS] JSON parse error: ${err.message}`);
      }
    });

    ws.on('close', () => {
      client.alive = false;
      onClose(client);
    });

    ws.on('error', (err) => {
      console.log(`[WS] Socket error: ${err.message}`);
      client.alive = false;
      onClose(client);
    });

    onClient(client);
  });
}

module.exports = {
  handleUpgrade,
  WSClient,
};
