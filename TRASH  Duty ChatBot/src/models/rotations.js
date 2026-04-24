'use strict';

const db = require('../db');

const LIST = db.prepare(`
  SELECT r.group_id, r.user_id, r.position, u.name, u.status
  FROM rotations r
  JOIN users u ON u.group_id = r.group_id AND u.user_id = r.user_id
  WHERE r.group_id = ?
  ORDER BY r.position ASC
`);

const GET = db.prepare(
  `SELECT * FROM rotations WHERE group_id = ? AND user_id = ?`
);

const INSERT = db.prepare(
  `INSERT INTO rotations (group_id, user_id, position) VALUES (?, ?, ?)`
);

const DELETE_ALL = db.prepare(`DELETE FROM rotations WHERE group_id = ?`);
const DELETE_USER = db.prepare(
  `DELETE FROM rotations WHERE group_id = ? AND user_id = ?`
);

const MAX_POS = db.prepare(
  `SELECT COALESCE(MAX(position), -1) AS max FROM rotations WHERE group_id = ?`
);

function list(groupId) {
  return LIST.all(groupId);
}

function get(groupId, userId) {
  return GET.get(groupId, userId);
}

function clear(groupId) {
  DELETE_ALL.run(groupId);
}

function removeUser(groupId, userId) {
  DELETE_USER.run(groupId, userId);
}

/**
 * Replace the rotation with the given ordered user list.
 * Positions are 0-indexed.
 */
const setAllTx = db.transaction((groupId, userIds) => {
  DELETE_ALL.run(groupId);
  userIds.forEach((uid, idx) => INSERT.run(groupId, uid, idx));
});

function setAll(groupId, userIds) {
  setAllTx(groupId, userIds);
}

/**
 * Append a user to the end of the rotation (for back-home / new member).
 * Returns the new position, or the existing position if already present.
 */
function appendUser(groupId, userId) {
  const existing = GET.get(groupId, userId);
  if (existing) return existing.position;
  const next = MAX_POS.get(groupId).max + 1;
  INSERT.run(groupId, userId, next);
  return next;
}

module.exports = {
  list,
  get,
  clear,
  setAll,
  appendUser,
  removeUser,
};
