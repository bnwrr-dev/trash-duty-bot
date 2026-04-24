'use strict';

const line = require('@line/bot-sdk');
const { config, assertLineCredentials } = require('./config');

let _client = null;

function getClient() {
  if (!_client) {
    assertLineCredentials();
    _client = new line.Client({
      channelAccessToken: config.line.channelAccessToken,
      channelSecret: config.line.channelSecret,
    });
  }
  return _client;
}

function middleware() {
  assertLineCredentials();
  return line.middleware({
    channelSecret: config.line.channelSecret,
  });
}

module.exports = { getClient, middleware, line };
