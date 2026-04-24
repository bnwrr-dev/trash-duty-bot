'use strict';

const express = require('express');

const { config } = require('./config');
const logger = require('./logger');
const { migrate } = require('./db/migrate');
const lineClient = require('./line');
const { handleEvent } = require('./handlers/webhook');
const scheduler = require('./services/scheduler');

migrate();

const app = express();

app.get('/', (_req, res) => res.status(200).send('trash-duty-bot ok'));
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true, ts: new Date().toISOString() }));

// IMPORTANT: LINE middleware verifies the X-Line-Signature header using the
// raw request body. It must run BEFORE any body parser that would consume it.
app.post('/webhook', lineClient.middleware(), async (req, res) => {
  // Respond 200 immediately to avoid LINE webhook timeouts (they expect <10s,
  // but the official recommendation is to ack fast and process async).
  res.status(200).end();
  const events = (req.body && req.body.events) || [];
  await Promise.all(
    events.map((event) =>
      Promise.resolve()
        .then(() => handleEvent(event))
        .catch((err) => logger.error({ err: err.message, stack: err.stack, event }, 'handleEvent failed'))
    )
  );
});

// Error handler for the LINE middleware signature failures.
app.use((err, _req, res, _next) => {
  if (err && err.signatureValidationFailed) {
    logger.warn({ signature: err.signature }, 'invalid LINE signature');
    return res.status(401).send('invalid signature');
  }
  logger.error({ err: err && err.message }, 'express error');
  res.status(500).send('server error');
});

const server = app.listen(config.server.port, () => {
  logger.info({ port: config.server.port, env: config.server.env }, 'server started');
});

const cronTask = scheduler.start();

function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  cronTask.stop();
  server.close(() => {
    logger.info('server closed');
    process.exit(0);
  });
  // Hard timeout in case something hangs.
  setTimeout(() => {
    logger.warn('force exit');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  logger.error({ err: err.message, stack: err.stack }, 'uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  logger.error({ reason: String(reason) }, 'unhandledRejection');
});
