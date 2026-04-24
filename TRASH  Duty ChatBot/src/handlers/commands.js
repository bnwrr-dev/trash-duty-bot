'use strict';

/**
 * Text-command handler. Commands are recognized in any group message that
 * starts with a slash (`/setup`) or with the bare keyword (`setup`). Matching
 * is case-insensitive and tolerant of extra whitespace.
 *
 * Because LINE group webhooks don't reliably expose @-mention targets as
 * userIds without the LINE Front-end Framework (LIFF), member-targeting
 * commands accept a DISPLAY NAME instead. Users register themselves with
 * `join` so the bot learns their userId.
 */

const groups = require('../models/groups');
const users = require('../models/users');
const rotations = require('../models/rotations');
const tasksModel = require('../models/tasks');
const history = require('../models/history');
const rotation = require('../services/rotation');
const messages = require('../services/messages');
const { replyTo, getGroupMemberProfile } = require('../services/notifier');
const { config } = require('../config');
const { currentWeekKey } = require('../services/weekUtil');
const logger = require('../logger');

const PREFIX_RE = /^\/?(\w[\w-]*)\s*(.*)$/s;

function parse(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  const m = trimmed.match(PREFIX_RE);
  if (!m) return null;
  return { cmd: m[1].toLowerCase(), args: m[2].trim() };
}

async function handle(event) {
  const text = event.message && event.message.type === 'text' ? event.message.text : '';
  const parsed = parse(text);
  if (!parsed) return;

  if (event.source.type !== 'group') {
    // In 1:1 chat, only respond to `help` to keep DM noise low.
    if (parsed.cmd === 'help') {
      return replyTo(event.replyToken, messages.plain(helpText()));
    }
    return;
  }

  const groupId = event.source.groupId;
  const userId = event.source.userId;

  const handler = COMMANDS[parsed.cmd];
  if (!handler) return;

  try {
    await handler({ event, groupId, userId, args: parsed.args });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack, cmd: parsed.cmd }, 'command failed');
    await replyTo(event.replyToken, messages.plain(`⚠️ Error: ${err.message}`));
  }
}

function helpText() {
  return [
    'Trash Duty Bot commands:',
    '',
    'Setup',
    '  setup [tz]            First caller becomes admin. Default tz: ' + config.tz.default,
    '  join                  Register yourself as a rotation member.',
    '  leave                 Remove yourself from rotation.',
    '',
    'Daily use',
    '  status                Show this week\'s assignment.',
    '  schedule              Show full rotation order.',
    '  members               List members and status.',
    '  history               Show recent history.',
    '  back                  Mark yourself back home (reactivate).',
    '',
    'Admin only',
    '  rotation A, B, C      Set rotation order by member names.',
    '  force <name>          Force-assign this week to <name>.',
    '  remove <name>         Remove a member from the group.',
    '  reset                 Reset rotation pointer.',
    '  pause / resume        Pause or resume assignments.',
    '  assign                Manually trigger this week\'s assignment.',
    '',
    'Tip: commands also work with a leading slash, e.g. /status',
  ].join('\n');
}

async function assertAdmin(groupId, userId, replyToken) {
  const group = groups.get(groupId);
  if (!group || !group.admin_user_id) {
    await replyTo(replyToken, messages.plain('No admin set. Run `setup` first.'));
    return false;
  }
  if (group.admin_user_id !== userId) {
    await replyTo(replyToken, messages.plain('⛔ Admin-only command.'));
    return false;
  }
  return true;
}

const COMMANDS = {
  help: async ({ event }) => replyTo(event.replyToken, messages.plain(helpText())),

  setup: async ({ event, groupId, userId, args }) => {
    const existing = groups.get(groupId);
    if (existing && existing.admin_user_id) {
      return replyTo(
        event.replyToken,
        messages.plain(
          `Group already set up. Admin is already assigned. Use \`reset\` or \`rotation\` to make changes.`
        )
      );
    }
    const tz = args || config.tz.default;
    groups.ensure(groupId, { tz, adminUserId: userId });
    groups.setAdmin(groupId, userId);

    // Register the admin as a member too.
    const profile = await getGroupMemberProfile(groupId, userId);
    const name = profile ? profile.displayName : 'Admin';
    users.upsert(groupId, userId, name, 'admin');
    rotations.appendUser(groupId, userId);

    return replyTo(
      event.replyToken,
      messages.plain(
        `✅ Setup complete.\nAdmin: ${name}\nTimezone: ${tz}\n\nEveryone who will participate, please type \`join\` in this chat to register.\nThen admin runs \`rotation <name1>, <name2>, ...\` to set the order, or just \`assign\` to start.`
      )
    );
  },

  join: async ({ event, groupId, userId }) => {
    groups.ensure(groupId, { tz: config.tz.default });
    const profile = await getGroupMemberProfile(groupId, userId);
    const name = profile ? profile.displayName : 'Member';
    users.upsert(groupId, userId, name, 'member');
    rotations.appendUser(groupId, userId);
    return replyTo(
      event.replyToken,
      messages.plain(`👋 ${name} joined the trash rotation.`)
    );
  },

  leave: async ({ event, groupId, userId }) => {
    const u = users.get(groupId, userId);
    if (!u) return replyTo(event.replyToken, messages.plain('You\'re not in the rotation.'));
    users.setStatus(groupId, userId, 'inactive');
    history.record(groupId, 'not_home', { userId, detail: { via: 'leave' } });
    return replyTo(
      event.replyToken,
      messages.plain(`${u.name} left the rotation. Use \`back\` to rejoin later.`)
    );
  },

  back: async ({ event, groupId, userId }) => {
    const u = users.get(groupId, userId);
    if (!u) return replyTo(event.replyToken, messages.plain('You\'re not registered. Type `join` first.'));
    rotation.backHome(groupId, userId);
    return replyTo(event.replyToken, messages.backHomeText({ name: u.name }));
  },

  members: async ({ event, groupId }) => {
    const list = users.list(groupId);
    if (list.length === 0) {
      return replyTo(event.replyToken, messages.plain('No members yet. Type `join` to register.'));
    }
    const lines = list.map(
      (u) => `${u.status === 'active' ? '🟢' : '⚪️'} ${u.name}${u.role === 'admin' ? ' (admin)' : ''}`
    );
    return replyTo(event.replyToken, messages.plain('Members:\n' + lines.join('\n')));
  },

  schedule: async ({ event, groupId }) => {
    const list = rotations.list(groupId);
    if (list.length === 0) {
      return replyTo(event.replyToken, messages.plain('No rotation set. Have members `join`, then admin runs `rotation <names>` or `assign`.'));
    }
    const group = groups.get(groupId);
    const lines = list.map((r, i) => {
      const marker = i === group.last_rotation_order ? '⬅ last' : '';
      return `${i + 1}. ${r.status === 'active' ? '🟢' : '⚪️'} ${r.name} ${marker}`.trim();
    });
    return replyTo(event.replyToken, messages.plain('Rotation order:\n' + lines.join('\n')));
  },

  status: async ({ event, groupId }) => {
    const group = groups.get(groupId);
    if (!group) return replyTo(event.replyToken, messages.plain('No group setup. Run `setup` first.'));
    const weekKey = currentWeekKey(group.tz);
    const task = tasksModel.currentForWeek(groupId, weekKey);
    if (!task) {
      return replyTo(
        event.replyToken,
        messages.plain(`No active task for week of ${weekKey}. Admin can run \`assign\`.`)
      );
    }
    const u = users.get(groupId, task.user_id);
    return replyTo(
      event.replyToken,
      messages.plain(
        `Current duty (week of ${task.week_key}): ${u ? u.name : task.user_id}\nStatus: ${task.status}`
      )
    );
  },

  history: async ({ event, groupId }) => {
    const rows = tasksModel.recentHistory(groupId, 12);
    if (rows.length === 0) {
      return replyTo(event.replyToken, messages.plain('No history yet.'));
    }
    const lines = rows.map((r) => {
      const when = r.completed_at || r.assigned_at;
      const icon =
        r.status === 'completed' ? '✅' :
        r.status === 'skipped' ? '⏭' :
        r.status === 'overdue' ? '⚠️' : '⏳';
      return `${icon} ${r.week_key} — ${r.name || r.user_id} — ${r.status}`;
    });
    return replyTo(event.replyToken, messages.plain('Recent history:\n' + lines.join('\n')));
  },

  rotation: async ({ event, groupId, userId, args }) => {
    if (!(await assertAdmin(groupId, userId, event.replyToken))) return;
    if (!args) {
      return replyTo(event.replyToken, messages.plain('Usage: rotation <name1>, <name2>, ...'));
    }
    const names = args.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    const matched = [];
    const unknown = [];
    for (const n of names) {
      const u = users.byName(groupId, n);
      if (u) matched.push(u.user_id);
      else unknown.push(n);
    }
    if (unknown.length) {
      return replyTo(
        event.replyToken,
        messages.plain(`Unknown members: ${unknown.join(', ')}. They need to \`join\` first.`)
      );
    }
    rotations.setAll(groupId, matched);
    groups.setLastRotationOrder(groupId, -1);
    history.record(groupId, 'rotation_reset', { detail: { order: names } });
    return replyTo(
      event.replyToken,
      messages.plain(`Rotation set: ${names.join(' → ')}`)
    );
  },

  force: async ({ event, groupId, userId, args }) => {
    if (!(await assertAdmin(groupId, userId, event.replyToken))) return;
    if (!args) return replyTo(event.replyToken, messages.plain('Usage: force <name>'));
    const target = users.byName(groupId, args);
    if (!target) return replyTo(event.replyToken, messages.plain(`No such member: ${args}`));
    const res = rotation.forceAssign(groupId, target.user_id);
    if (!res.task) return replyTo(event.replyToken, messages.plain(`Could not assign: ${res.reason}`));
    return replyTo(event.replyToken, [
      messages.forceAssignText({ name: target.name }),
      messages.assignmentTemplate({ name: target.name, taskId: res.task.task_id, weekKey: res.task.week_key }),
    ]);
  },

  remove: async ({ event, groupId, userId, args }) => {
    if (!(await assertAdmin(groupId, userId, event.replyToken))) return;
    if (!args) return replyTo(event.replyToken, messages.plain('Usage: remove <name>'));
    const target = users.byName(groupId, args);
    if (!target) return replyTo(event.replyToken, messages.plain(`No such member: ${args}`));
    rotations.removeUser(groupId, target.user_id);
    users.remove(groupId, target.user_id);
    return replyTo(event.replyToken, messages.plain(`Removed ${target.name}.`));
  },

  reset: async ({ event, groupId, userId }) => {
    if (!(await assertAdmin(groupId, userId, event.replyToken))) return;
    rotation.resetRotation(groupId);
    return replyTo(event.replyToken, messages.plain('Rotation pointer reset. Next `assign` starts from position 1.'));
  },

  pause: async ({ event, groupId, userId }) => {
    if (!(await assertAdmin(groupId, userId, event.replyToken))) return;
    groups.setPaused(groupId, true);
    history.record(groupId, 'paused');
    return replyTo(event.replyToken, messages.plain('⏸ System paused. No assignments will be sent until `resume`.'));
  },

  resume: async ({ event, groupId, userId }) => {
    if (!(await assertAdmin(groupId, userId, event.replyToken))) return;
    groups.setPaused(groupId, false);
    history.record(groupId, 'resumed');
    return replyTo(event.replyToken, messages.plain('▶️ System resumed.'));
  },

  assign: async ({ event, groupId, userId }) => {
    if (!(await assertAdmin(groupId, userId, event.replyToken))) return;
    const res = rotation.assignForCurrentWeek(groupId, { force: false });
    if (!res.task) {
      return replyTo(event.replyToken, messages.plain(`Cannot assign: ${res.reason}`));
    }
    return replyTo(
      event.replyToken,
      messages.assignmentTemplate({
        name: res.user.name,
        taskId: res.task.task_id,
        weekKey: res.task.week_key,
      })
    );
  },
};

module.exports = { handle, parse, helpText };
