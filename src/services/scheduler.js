'use strict';

/**
 * Cron scheduler.
 *
 * Design: we run ONE minutely tick. Inside the tick we iterate over all
 * groups and check, in that group's local timezone, whether it is
 *   Thursday at ASSIGN_HOUR:ASSIGN_MINUTE → assign for this week
 *   Monday at REMIND_HOUR:REMIND_MINUTE → send reminder if pending
 *
 * Running one unified tick (rather than per-group cron expressions) keeps
 * the scheduler stateless and simple while still honoring per-group TZ.
 *
 * Each tick is guarded by a per-group week_key + job-name marker stored as
 * the most recent history entry, so we don't double-fire on minute overlaps.
 */

const cron = require('node-cron');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

const db = require('../db');
const groups = require('../models/groups');
const users = require('../models/users');
const tasksModel = require('../models/tasks');
const history = require('../models/history');
const rotation = require('./rotation');
const messages = require('./messages');
const { pushToGroup } = require('./notifier');
const { currentWeekKey } = require('./weekUtil');
const { config } = require('../config');
const logger = require('../logger');

const HAS_RUN = db.prepare(`
  SELECT 1 FROM history
  WHERE group_id = ? AND event = ? AND week_key = ?
  LIMIT 1
`);

function hasRun(groupId, event, weekKey) {
  return !!HAS_RUN.get(groupId, event, weekKey);
}

async function runAssignment(group) {
  const weekKey = currentWeekKey(group.tz);
  if (hasRun(group.group_id, 'scheduler_assigned', weekKey)) return;

  const res = rotation.assignForCurrentWeek(group.group_id);
  if (res.task && res.user) {
    try {
      await pushToGroup(group.group_id, messages.assignmentTemplate({
        name: res.user.name,
        taskId: res.task.task_id,
        weekKey: res.task.week_key,
      }));
    } catch (err) {
      logger.error({ err: err.message, groupId: group.group_id }, 'push assignment failed');
    }
  } else {
    logger.info({ groupId: group.group_id, reason: res.reason }, 'assignment skipped');
  }
  // Record the job run regardless, to avoid re-firing.
  history.record(group.group_id, 'scheduler_assigned', { weekKey, detail: { reason: res.reason || 'ok' } });
}

async function runReminder(group) {
  const weekKey = currentWeekKey(group.tz);
  if (hasRun(group.group_id, 'scheduler_reminded', weekKey)) return;

  const task = tasksModel.currentForWeek(group.group_id, weekKey);
  if (task && task.status === 'pending') {
    const u = users.get(group.group_id, task.user_id);
    try {
      await pushToGroup(group.group_id, messages.reminderText({ name: u ? u.name : 'Member' }));
      history.record(group.group_id, 'reminded', {
        taskId: task.task_id, weekKey, userId: task.user_id,
      });
    } catch (err) {
      logger.error({ err: err.message, groupId: group.group_id }, 'push reminder failed');
    }
  }
  history.record(group.group_id, 'scheduler_reminded', { weekKey });
}

async function tick() {
  const all = groups.all();
  for (const group of all) {
    if (group.paused) continue;
    const nowLocal = dayjs().tz(group.tz);
    const dow = nowLocal.day(); // 0 Sun .. 6 Sat; 4=Thu, 1=Mon
    const h = nowLocal.hour();
    const m = nowLocal.minute();

    if (dow === 4 && h === config.schedule.assignHour && m === config.schedule.assignMinute) {
      await runAssignment(group);
    }
    if (dow === 1 && h === config.schedule.remindHour && m === config.schedule.remindMinute) {
      await runReminder(group);
    }
  }
}

function start() {
  // Every minute.
  const task = cron.schedule('* * * * *', () => {
    tick().catch((err) => logger.error({ err: err.message }, 'scheduler tick failed'));
  });
  logger.info('scheduler started (minutely tick)');
  return task;
}

module.exports = { start, tick, runAssignment, runReminder };
