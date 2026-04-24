'use strict';

const { getClient } = require('../line');
const logger = require('../logger');

const MAX_RETRIES = 3;

async function withRetry(fn, label) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err && err.statusCode;
      const retryable = !status || status >= 500 || status === 429;
      logger.warn({ err: err.message, status, attempt, label }, 'LINE call failed');
      if (!retryable || attempt === MAX_RETRIES) break;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw lastErr;
}

async function pushToGroup(groupId, messages) {
  const client = getClient();
  const arr = Array.isArray(messages) ? messages : [messages];
  return withRetry(() => client.pushMessage(groupId, arr), 'pushMessage');
}

async function replyTo(replyToken, messages) {
  const client = getClient();
  const arr = Array.isArray(messages) ? messages : [messages];
  return withRetry(() => client.replyMessage(replyToken, arr), 'replyMessage');
}

async function getGroupMemberProfile(groupId, userId) {
  const client = getClient();
  try {
    return await client.getGroupMemberProfile(groupId, userId);
  } catch (err) {
    logger.warn({ err: err.message, groupId, userId }, 'getGroupMemberProfile failed');
    return null;
  }
}

module.exports = { pushToGroup, replyTo, getGroupMemberProfile };
