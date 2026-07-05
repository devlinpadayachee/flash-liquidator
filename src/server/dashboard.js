/**
 * Dashboard server - serves the live UI and streams bot state over SSE.
 *
 * Runs in-process with the bot. Read-only: it never touches liquidation logic.
 * Binds 0.0.0.0:$PORT so it works on Render (which injects PORT and probes
 * /health). If DASHBOARD_TOKEN is set, the data API requires that token.
 */

const path = require('path');
const express = require('express');
const botState = require('./botState');

function startDashboard() {
  const app = express();
  const PORT = parseInt(process.env.PORT || process.env.DASHBOARD_PORT || '3001', 10);
  const TOKEN = process.env.DASHBOARD_TOKEN || null;

  app.disable('x-powered-by');

  // --- Health check (always open, no auth) - Render probes this ---
  app.get('/health', (_req, res) => {
    const s = botState.getState();
    res.json({
      status: 'ok',
      running: s.status.running,
      chain: s.status.chain,
      uptimeMs: s.status.uptimeMs,
      liquidations: s.stats.liquidationsSuccessful,
      totalProfitUSD: s.stats.totalProfitUSD,
    });
  });

  // --- Token gate for the data API only (page/assets stay public) ---
  const auth = (req, res, next) => {
    if (!TOKEN) return next();
    const provided =
      req.query.token ||
      req.headers['x-dashboard-token'] ||
      (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (provided === TOKEN) return next();
    res.status(401).json({ error: 'unauthorized', tokenRequired: true });
  };

  // --- Full state snapshot (initial page load) ---
  app.get('/api/state', auth, (_req, res) => {
    res.json(botState.getState());
  });

  app.get('/api/meta', (_req, res) => {
    res.json({ tokenRequired: !!TOKEN });
  });

  // --- Server-Sent Events stream ---
  app.get('/api/stream', auth, (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable proxy buffering (nginx/Render)
    });
    res.write('retry: 3000\n\n');

    // Prime the client with the current full state
    res.write(`event: snapshot\ndata: ${JSON.stringify(botState.getState())}\n\n`);

    const onSse = ({ type, data }) => {
      try {
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch (_) {
        cleanup();
      }
    };
    botState.on('sse', onSse);

    // Heartbeat so proxies/Render don't drop an idle connection
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (_) { cleanup(); }
    }, 15000);

    const cleanup = () => {
      clearInterval(heartbeat);
      botState.removeListener('sse', onSse);
      try { res.end(); } catch (_) {}
    };

    req.on('close', cleanup);
    req.on('error', cleanup);
  });

  // --- Static frontend ---
  const publicDir = path.join(__dirname, '..', '..', 'public');
  app.use(express.static(publicDir, { maxAge: '1h', index: false }));
  app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  const server = app.listen(PORT, '0.0.0.0', () => {
    const authNote = TOKEN ? ' (token-protected)' : '';
    console.log(`   📊 Dashboard live on http://localhost:${PORT}${authNote}`);
  });

  server.on('error', (err) => {
    console.log(`   ⚠️ Dashboard server error (non-fatal): ${err.message}`);
  });

  return server;
}

module.exports = { startDashboard };
