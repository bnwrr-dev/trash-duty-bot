'use strict';

/**
 * Rotation semantics (matching PRD §6 and §9).
 *
 * Rotation order is stable. Positions are 0-indexed. `group.last_rotation_order`
 * stores the position of the user most recently assigned. To pick the next
 * assignee, we walk forward from `last_rotation_order + 1`, skipping any user
 * whose status != 'active', wrapping around the list.
 *
 * "Not Free" (this-week-only pass):
 *   - Mark the current task 'skipped' with reason 'not_free'.
 *   - Pick the next active user (starting from the position AFTER the skipper)
 *     and create a replacement task for the same week.
 *   - Advance `last_rotation_order` to the replacement's position. This means
 *     the replacement takes the slot and the rotation continues after them,
 *     so the skipper effectively goes to the back of the line. Everyone still
 *     does one duty per full cycle (fair over time).
 *
 * "Not at Home":
 *   - Set user.status = 'inactive'. They are skipped in future assignments.
 *   - If they were the current assignee, trigger the same replacement flow as
 *     Not Free (but with reason 'not_home').
 *
 * "Back Home":
 *   - Set user.status = 'active'. They are considered in future assignments.
 *   - Their rotation position is preserved (we never delete it), so they
 *     re-enter at their original slot when next passed.
 *
 * "Overdue":
 *   - If a pending task still exists when the next week's assignment job runs,
 *     mark the previous task 'overdue' for audit. Admin can `force assign`.
 */

const dayjs = require('dayjs');

const groups = require('../models/groups');
const users = require('../models/users');
const rotations = require('../models/rotations');
const tasks = require('../models/tasks');
const history = require('../models/history');
const { currentWeekKey } = require('./weekUtil');
const { config } = require('../config');

function getRotationUsers(groupId) {
  return rotations.list(groupId);
}

/**
 * Pick the next active user to assign, starting AFTER the given position.
 * Returns the user row from the rotation join, or null if no active users exist.
 * `excludeUserIds` lets callers skip specific users (e.g. the one who just
 * said "not free" so they don't get reassigned their own task).
 */
function pickNextActive(groupId, afterPosition, excludeUserIds = []) {
  const list = getRotationUsers(groupId);
  if (list.length === 0) return null;

  const excluded = new Set(excludeUserIds);
  const n = list.length;
  // Start search from afterPosition + 1, wrap around.
  for (let step = 1; step <= n; step++) {
    const idx = ((afterPosition + step) % n + n) % n;
    const candidate = list[idx];
    if (candidate.status === 'active' && !excluded.has(candidate.user_id)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Assign the next active user for the current week in the given group.
 * Returns { task, user } if assigned, or { reason } if nothing to do.
 */
function assignForCurrentWeek(groupId, { force = false } = {}) {
  const group = groups.get(groupId);
  if (!group) return { reason: 'group_not_found' };
  if (group.paused && !force) return { reason: 'paused' };

  const weekKey = currentWeekKey(group.tz);

  // Handle overdue: if there is still a pending task from a previous week,
  // mark it overdue before moving on.
  const pending = tasks.pendingForGroup(groupId);
  for (const p of pending) {
    if (p.week_key !== weekKey) {
      tasks.updateStatus(p.task_id, 'overdue');
      history.record(groupId, 'overdue', {
        taskId: p.task_id,
        weekKey: p.week_key,
        userId: p.user_id,
      });
    }
  }

  // If a task for this week already exists, don't double-assign.
  const existing = tasks.latestForWeek(groupId, weekKey);
  if (existing && !force) {
    return { reason: 'already_assigned', task: existing };
  }

  const next = pickNextActive(groupId, group.last_rotation_order);
  if (!next) return { reason: 'no_active_members' };

  const task = tasks.create(groupId, weekKey, next.user_id);
  groups.setLastRotationOrder(groupId, next.position);
  history.record(groupId, 'assigned', {
    taskId: task.task_id,
    weekKey,
    userId: next.user_id,
  });
  return { task, user: next };
}

/**
 * Mark the current task done.
 */
function markDone(groupId, taskId, byUserId) {
  const task = tasks.get(taskId);
  if (!task || task.group_id !== groupId) return { reason: 'not_found' };
  if (task.status === 'completed') return { reason: 'already_completed', task };
  if (task.status !== 'pending' && task.status !== 'overdue') {
    return { reason: 'not_pending', task };
  }
  const updated = tasks.updateStatus(taskId, 'completed');
  history.record(groupId, 'completed', {
    taskId,
    weekKey: task.week_key,
    userId: byUserId || task.user_id,
  });
  return { task: updated };
}

/**
 * Undo a Done click within the configured window. Reverts to pending.
 */
function undoDone(groupId, taskId, byUserId) {
  const task = tasks.get(taskId);
  if (!task || task.group_id !== groupId) return { reason: 'not_found' };
  if (task.status !== 'completed') return { reason: 'not_completed', task };
  const completedAt = task.completed_at ? dayjs(task.completed_at + 'Z') : null;
  if (!completedAt) return { reason: 'no_timestamp' };
  const hoursSince = dayjs().diff(completedAt, 'hour', true);
  if (hoursSince > config.undo.windowHours) {
    return { reason: 'window_expired', hoursSince };
  }
  const updated = tasks.updateStatus(taskId, 'pending');
  history.record(groupId, 'undone', {
    taskId,
    weekKey: task.week_key,
    userId: byUserId || task.user_id,
    detail: { hoursSince },
  });
  return { task: updated };
}

/**
 * Handle "Not Free" or "Not at Home". Skips the current task and assigns
 * a replacement within the same week. For 'not_home' also marks the user inactive.
 */
function skipAndReassign(groupId, taskId, reason) {
  if (!['not_free', 'not_home', 'force_reassign'].includes(reason)) {
    throw new Error(`invalid skip reason: ${reason}`);
  }
  const task = tasks.get(taskId);
  if (!task || task.group_id !== groupId) return { reason: 'not_found' };
  if (task.status !== 'pending' && task.status !== 'overdue') {
    return { reason: 'not_pending', task };
  }

  const group = groups.get(groupId);
  if (!group) return { reason: 'group_not_found' };

  // If 'not_home', deactivate the user first so they are excluded from future rotations.
  if (reason === 'not_home') {
    users.setStatus(groupId, task.user_id, 'inactive');
    history.record(groupId, 'not_home', { userId: task.user_id, taskId });
  } else if (reason === 'not_free') {
    history.record(groupId, 'not_free', { userId: task.user_id, taskId });
  }

  // Find replacement: start from the skipper's position, skipping the skipper themselves.
  const skipperRotation = rotations.get(groupId, task.user_id);
  const startPosition = skipperRotation ? skipperRotation.position : group.last_rotation_order;
  const replacement = pickNextActive(groupId, startPosition, [task.user_id]);

  if (!replacement) {
    // No replacement available — mark original skipped but leave no pending task.
    tasks.updateStatus(taskId, 'skipped', { skippedReason: reason });
    return { reason: 'no_replacement', task };
  }

  // Create the replacement task.
  const newTask = tasks.create(groupId, task.week_key, replacement.user_id);
  tasks.updateStatus(taskId, 'skipped', {
    skippedReason: reason,
    supersededBy: newTask.task_id,
  });
  groups.setLastRotationOrder(groupId, replacement.position);
  history.record(groupId, 'assigned', {
    taskId: newTask.task_id,
    weekKey: newTask.week_key,
    userId: replacement.user_id,
    detail: { supersedes: taskId, reason },
  });

  return { task: newTask, user: replacement, supersededTaskId: taskId };
}

/**
 * Admin force-reassign: reassign current week's task to a specific user.
 */
function forceAssign(groupId, targetUserId) {
  const group = groups.get(groupId);
  if (!group) return { reason: 'group_not_found' };
  const weekKey = currentWeekKey(group.tz);
  const target = users.get(groupId, targetUserId);
  if (!target) return { reason: 'user_not_found' };

  const current = tasks.currentForWeek(groupId, weekKey);
  if (current) {
    tasks.updateStatus(current.task_id, 'skipped', { skippedReason: 'force_reassign' });
  }

  const newTask = tasks.create(groupId, weekKey, targetUserId);
  const rot = rotations.get(groupId, targetUserId);
  if (rot) groups.setLastRotationOrder(groupId, rot.position);
  history.record(groupId, 'force_assigned', {
    taskId: newTask.task_id,
    weekKey,
    userId: targetUserId,
    detail: { supersedes: current ? current.task_id : null },
  });
  return { task: newTask, user: target };
}

/**
 * Mark a member Back Home (reactivate).
 */
function backHome(groupId, userId) {
  const user = users.get(groupId, userId);
  if (!user) return { reason: 'not_found' };
  users.setStatus(groupId, userId, 'active');
  history.record(groupId, 'back_home', { userId });
  return { user: users.get(groupId, userId) };
}

/**
 * Reset rotation: clear last_rotation_order so next assignment starts from position 0.
 */
function resetRotation(groupId) {
  groups.setLastRotationOrder(groupId, -1);
  history.record(groupId, 'rotation_reset');
}

module.exports = {
  assignForCurrentWeek,
  markDone,
  undoDone,
  skipAndReassign,
  forceAssign,
  backHome,
  resetRotation,
  pickNextActive,
};
