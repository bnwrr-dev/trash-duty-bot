'use strict';

const groups = require('../models/groups');
const users = require('../models/users');
const commands = require('./commands');
const postbacks = require('./postbacks');
const messages = require('../services/messages');
const { replyTo } = require('../services/notifier');
const { config } = require('../config');
const logger = require('../logger');

async function handleEvent(event) {
  logger.debug({ type: event.type, source: event.source }, 'event');

  switch (event.type) {
    case 'join':
      // Bot was added to a group. Pre-create the group record.
      if (event.source.type === 'group') {
        groups.ensure(event.source.groupId, { tz: config.tz.default });
        return replyTo(event.replyToken, messages.plain(
          '👋 Trash Duty Bot is online.\nType `setup` to begin. Type `help` for all commands.'
        ));
      }
      return;

    case 'leave':
      // Bot removed from group. Keep data for audit; do not delete automatically.
      return;

    case 'memberJoined':
      // New human joined. Don't auto-register (need userId & consent).
      return;

    case 'memberLeft':
      if (event.source.type === 'group' && event.left && Array.isArray(event.left.members)) {
        for (const m of event.left.members) {
          if (m.userId) users.setStatus(event.source.groupId, m.userId, 'inactive');
        }
      }
      return;

    case 'message':
      if (event.message && event.message.type === 'text') {
        return commands.handle(event);
      }
      return;

    case 'postback':
      return postbacks.handle(event);

    default:
      return;
  }
}

module.exports = { handleEvent };
