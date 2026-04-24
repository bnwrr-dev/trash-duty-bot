'use strict';

const db = require('../db');

const INSERT = db.prepare(`
  INSERT INTO history (group_id, task_id, week_key, user_id, event, detail)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const RECENT = db.prepare(`
  SELECT h.*, u.name
  FROM history h
  LEFT JOIN users u ON u.group_id = h.group_id AND u.user_id = h.user_id
  WHERE h.group_id = ?
  ORDER BY h.created_at DESC
  LIMIT ?
`);

function record(groupId, event, { taskId = null, weekKey = null, userId = null, detail = null } = {}) {
  INSERT.run(
    groupId,
    taskId,
    weekKey,
    userId,
    event,
    detail ? (typeof detail === 'string' ? detail : JSON.stringify(detail)) : null
  );
}

function recent(groupId, limit = 20) {
  return RECENT.all(groupId, limit);
}

module.exports = { record, recent };
