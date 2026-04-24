'use strict';

const db = require('../db');

const INSERT = db.prepare(`
  INSERT INTO tasks (group_id, week_key, user_id, status)
  VALUES (?, ?, ?, 'pending')
`);

const GET = db.prepare(`SELECT * FROM tasks WHERE task_id = ?`);

const CURRENT = db.prepare(`
  SELECT * FROM tasks
  WHERE group_id = ? AND week_key = ? AND status IN ('pending', 'overdue')
  ORDER BY task_id DESC LIMIT 1
`);

const LATEST_FOR_WEEK = db.prepare(`
  SELECT * FROM tasks
  WHERE group_id = ? AND week_key = ?
  ORDER BY task_id DESC LIMIT 1
`);

const LIST_FOR_WEEK = db.prepare(`
  SELECT * FROM tasks
  WHERE group_id = ? AND week_key = ?
  ORDER BY task_id ASC
`);

const PENDING_FOR_GROUP = db.prepare(`
  SELECT * FROM tasks
  WHERE group_id = ? AND status = 'pending'
  ORDER BY task_id ASC
`);

const UPDATE_STATUS = db.prepare(`
  UPDATE tasks SET status = ?,
    completed_at = CASE WHEN ? = 'completed' THEN datetime('now') ELSE completed_at END,
    skipped_reason = COALESCE(?, skipped_reason),
    superseded_by = COALESCE(?, superseded_by)
  WHERE task_id = ?
`);

const RECENT_HISTORY = db.prepare(`
  SELECT t.task_id, t.week_key, t.user_id, u.name, t.status, t.assigned_at, t.completed_at
  FROM tasks t
  LEFT JOIN users u ON u.group_id = t.group_id AND u.user_id = t.user_id
  WHERE t.group_id = ?
  ORDER BY t.week_key DESC, t.task_id DESC
  LIMIT ?
`);

function create(groupId, weekKey, userId) {
  const info = INSERT.run(groupId, weekKey, userId);
  return GET.get(info.lastInsertRowid);
}

function get(taskId) {
  return GET.get(taskId);
}

function currentForWeek(groupId, weekKey) {
  return CURRENT.get(groupId, weekKey);
}

function latestForWeek(groupId, weekKey) {
  return LATEST_FOR_WEEK.get(groupId, weekKey);
}

function listForWeek(groupId, weekKey) {
  return LIST_FOR_WEEK.all(groupId, weekKey);
}

function pendingForGroup(groupId) {
  return PENDING_FOR_GROUP.all(groupId);
}

/**
 * Update a task's status. Options:
 *   skippedReason: 'not_free' | 'not_home' | 'force_reassign' (only when status='skipped')
 *   supersededBy: taskId that replaced this task
 */
function updateStatus(taskId, status, { skippedReason = null, supersededBy = null } = {}) {
  UPDATE_STATUS.run(status, status, skippedReason, supersededBy, taskId);
  return GET.get(taskId);
}

function recentHistory(groupId, limit = 20) {
  return RECENT_HISTORY.all(groupId, limit);
}

module.exports = {
  create,
  get,
  currentForWeek,
  latestForWeek,
  listForWeek,
  pendingForGroup,
  updateStatus,
  recentHistory,
};
