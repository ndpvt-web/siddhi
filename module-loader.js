/**
 * module-loader.js - Dynamic module loader for Atlas
 * Creates Express-compatible adapter over Node raw HTTP for module mounting.
 */
'use strict';

const url = require('url');

function expressify(req, res) {
  // Parse body (already parsed by server.js, but modules may expect req.body)
  // Add Express-like methods to res
  if (!res.status) {
    res.status = (code) => {
      res.statusCode = code;
      return res;
    };
  }
  if (!res.json) {
    res.json = (data) => {
      if (!res.headersSent) {
        res.writeHead(res.statusCode || 200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
      }
      res.end(JSON.stringify(data));
    };
  }
  if (!res.send) {
    res.send = (data) => {
      if (typeof data === 'object') return res.json(data);
      if (!res.headersSent) {
        res.writeHead(res.statusCode || 200, {
          'Content-Type': 'text/plain',
          'Access-Control-Allow-Origin': '*',
        });
      }
      res.end(String(data));
    };
  }
  if (!res.setHeader) {
    const orig = res.setHeader;
    // setHeader exists on raw res, just ensure no crash
  }
  if (!res.type) {
    res.type = (t) => { res.setHeader('Content-Type', t); return res; };
  }
  // Parse query params
  if (!req.query) {
    const parsed = url.parse(req.url, true);
    req.query = parsed.query || {};
  }
  // Route params placeholder
  if (!req.params) {
    req.params = {};
  }
}

function loadModules(routes, authenticate, send) {
  // Create Express-like app adapter with middleware wrapper
  const app = {};
  
  ['get', 'post', 'put', 'delete'].forEach(method => {
    app[method] = (path, handler) => {
      const key = method.toUpperCase() + ' ' + path;
      routes[key] = async (req, res) => {
        expressify(req, res);
        // Parse JSON body for POST/PUT
        if ((method === 'post' || method === 'put') && !req.body) {
          try {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const raw = Buffer.concat(chunks).toString();
            req.body = raw ? JSON.parse(raw) : {};
          } catch (e) {
            req.body = {};
          }
        }
        return handler(req, res);
      };
    };
  });

  // Computer Use module
  try {
    const cu = require('./modules/computer-use');
    cu.mountComputerUseRoutes(app);
    console.log('[loader] computer-use routes mounted');
  } catch (e) {
    console.error('[loader] computer-use FAILED:', e.message);
    console.error('[loader]', e.stack?.split('\n').slice(0, 3).join('\n'));
  }

  // Learning module
  try {
    const learning = require('./modules/learning');
    if (typeof learning.mountRoutes === 'function') {
      learning.mountRoutes(app);
      console.log('[loader] learning mounted');
    }
  } catch (e) {
    console.log('[loader] learning skipped:', e.message);
  }
}

module.exports = { loadModules };
