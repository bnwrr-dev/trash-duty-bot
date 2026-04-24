'use strict';

require('dotenv').config();

function required(name) {
  const v = process.env[name];
  if (!v) {
    // Don't throw at require time in dev; throw when consumer actually needs it.
    return '';
  }
  return v;
}

const config = {
  line: {
    channelAccessToken: required('LINE_CHANNEL_ACCESS_TOKEN'),
    channelSecret: required('LINE_CHANNEL_SECRET'),
  },
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    env: process.env.NODE_ENV || 'development',
  },
  db: {
    path: process.env.DATABASE_PATH || './data/trashbot.db',
  },
  tz: {
    default: process.env.DEFAULT_TZ || 'Asia/Taipei',
  },
  schedule: {
    assignHour: parseInt(process.env.ASSIGN_HOUR || '9', 10),
    assignMinute: parseInt(process.env.ASSIGN_MINUTE || '0', 10),
    remindHour: parseInt(process.env.REMIND_HOUR || '19', 10),
    remindMinute: parseInt(process.env.REMIND_MINUTE || '0', 10),
  },
  undo: {
    windowHours: parseInt(process.env.UNDO_WINDOW_HOURS || '24', 10),
  },
  log: {
    level: process.env.LOG_LEVEL || 'info',
  },
};

function assertLineCredentials() {
  if (!config.line.channelAccessToken || !config.line.channelSecret) {
    throw new Error(
      'Missing LINE credentials. Set LINE_CHANNEL_ACCESS_TOKEN and LINE_CHANNEL_SECRET in .env.'
    );
  }
}

module.exports = { config, assertLineCredentials };
