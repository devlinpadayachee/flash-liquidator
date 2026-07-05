/**
 * Mirrors console output into BotState so the dashboard shows a live log feed.
 * The original console behavior is preserved (terminal still works); we just
 * additionally strip ANSI colors and forward each line with a severity level.
 */

const util = require('util');
const botState = require('./botState');

const ANSI = /\x1B\[[0-9;]*m/g;

function levelFor(line) {
  if (/❌|\berror\b|\bfail|revert|exception|uncaught/i.test(line)) return 'error';
  if (/⚠️|\bwarn|hiccup|timeout|closed|disabl/i.test(line)) return 'warn';
  if (/✅|🎉|success|profit|liquidation successful|deployed/i.test(line)) return 'success';
  return 'info';
}

function installLogCapture() {
  for (const method of ['log', 'info', 'warn', 'error']) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args); // keep terminal output intact
      try {
        const raw = args
          .map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 2 })))
          .join(' ');
        const clean = raw.replace(ANSI, '').replace(/\r/g, '');
        for (const line of clean.split('\n')) {
          if (line.trim() === '') continue;
          const level = method === 'error' ? 'error' : method === 'warn' ? 'warn' : levelFor(line);
          botState.pushLog(level, line);
        }
      } catch (_) {
        // never let logging break the bot
      }
    };
  }
}

module.exports = { installLogCapture };
