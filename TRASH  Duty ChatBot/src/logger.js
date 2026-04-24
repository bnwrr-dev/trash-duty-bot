'use strict';

const pino = require('pino');
const { config } = require('./config');

const logger = pino({
  level: config.log.level,
  transport:
    config.server.env === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
      : undefined,
});

module.exports = logger;
