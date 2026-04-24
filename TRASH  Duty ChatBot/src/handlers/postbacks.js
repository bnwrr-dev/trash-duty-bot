'use strict';

const qs = require('querystring');

const tasksModel = require('../models/tasks');
const users = require('../models/users');
const rotation = require('../services/rotation');
const messages = require('../services/messages');
const { replyTo } = require('../services/notifier');
const logger = require('../logger');

async function handle(event) {
  if (event.type !== 'postback') return;
  const data = qs.parse(event.postback && event.postback.data);
  const action = data.action;
  const taskId = parseInt(data.taskId, 10);
  const groupId = event.source.groupId;
  const actorId = event.source.userId;

  if (!groupId) {
    return replyTo(event.replyToken, messages.plain('This action only works in a group.'));
  }
  if (!taskId) {
    return replyTo(event.replyToken, messages.plain('Missing task reference.'));
  }

  const task = tasksModel.get(taskId);
  if (!task || task.group_id !== groupId) {
    return replyTo(event.replyToken, messages.plain('Task not found or no longer active.'));
  }

  try {
    switch (action) {
      case 'done':
        return await handleDone(event, task, actorId);
      case 'not_free':
        return await handleSkip(event, task, 'not_free');
      case 'not_home':
        return await handleSkip(event, task, 'not_home');
      case 'undo':
        return await handleUndo(event, task, actorId);
      default:
        return replyTo(event.replyToken, messages.plain(`Unknown action: ${action}`));
    }
  } catch (err) {
    logger.error({ err: err.message, action, taskId }, 'postback failed');
    return replyTo(event.replyToken, messages.plain(`⚠️ Error: ${err.message}`));
  }
}

async function handleDone(event, task, actorId) {
  const res = rotation.markDone(task.group_id, task.task_id, actorId);
  if (!res.task) {
    if (res.reason === 'already_completed') {
      return replyTo(event.replyToken, messages.plain('Already marked Done.'));
    }
    return replyTo(event.replyToken, messages.plain(`Could not complete: ${res.reason}`));
  }
  const u = users.get(task.group_id, task.user_id);
  return replyTo(
    event.replyToken,
    messages.completedTemplate({ name: u ? u.name : 'Member', taskId: task.task_id })
  );
}

async function handleSkip(event, task, reason) {
  const skipper = users.get(task.group_id, task.user_id);
  const res = rotation.skipAndReassign(task.group_id, task.task_id, reason);
  if (!res.task) {
    if (res.reason === 'no_replacement') {
      return replyTo(event.replyToken, [
        messages.plain(`${skipper ? skipper.name : 'Member'} marked ${reason === 'not_home' ? 'Not at Home' : 'Not Free'}.`),
        messages.plain('⚠️ No other active members available. Admin, please `force <name>` or `back` someone.'),
      ]);
    }
    return replyTo(event.replyToken, messages.plain(`Could not reassign: ${res.reason}`));
  }
  const replies = [
    messages.skipText({
      skipperName: skipper ? skipper.name : 'Member',
      newAssigneeName: res.user.name,
      reason,
    }),
    messages.assignmentTemplate({
      name: res.user.name,
      taskId: res.task.task_id,
      weekKey: res.task.week_key,
    }),
  ];
  return replyTo(event.replyToken, replies);
}

async function handleUndo(event, task, actorId) {
  const res = rotation.undoDone(task.group_id, task.task_id, actorId);
  if (!res.task) {
    if (res.reason === 'window_expired') {
      return replyTo(event.replyToken, messages.plain('Undo window (24h) has passed.'));
    }
    if (res.reason === 'not_completed') {
      return replyTo(event.replyToken, messages.plain('Task was not marked Done.'));
    }
    return replyTo(event.replyToken, messages.plain(`Could not undo: ${res.reason}`));
  }
  const u = users.get(task.group_id, task.user_id);
  return replyTo(event.replyToken, [
    messages.plain(`↩ Undone. ${u ? u.name : 'Member'}'s duty is pending again.`),
    messages.assignmentTemplate({
      name: u ? u.name : 'Member',
      taskId: task.task_id,
      weekKey: task.week_key,
    }),
  ]);
}

module.exports = { handle };
