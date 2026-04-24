'use strict';

const db = require('../db');

const UPSERT = db.prepare(`
  INSERT INTO users (group_id, user_id, name, role, status)
  VALUES (?, ?, ?, ?, 'active')
  ON CONFLICT(group_id, user_id) DO UPDATE SET
    name = excluded.name,
    status = 'active'
`);

const GET = db.prepare(`SELECT * FROM users WHERE group_id = ? AND user_id = ?`);
const BY_NAME = db.prepare(
  `SELECT * FROM users WHERE group_id = ? AND LOWER(name) = LOWER(?)`
);
const LIST = db.prepare(`SELECT * FROM users WHERE group_id = ? ORDER BY joined_at`);
const LIST_ACTIVE = db.prepare(
  `SELECT * FROM users WHERE group_id = ? AND status = 'active' ORDER BY joined_at`
);

const SET_STATUS = db.prepare(
  `UPDATE users SET status = ? WHERE group_id = ? AND user_id = ?`
);
const SET_ROLE = db.prepare(
  `UPDATE users SET role = ? WHERE group_id = ? AND user_id = ?`
);
const RENAME = db.prepare(
  `UPDATE users SET name = ? WHERE group_id = ? AND user_id = ?`
);
const DELETE = db.prepare(`DELETE FROM users WHERE group_id = ? AND user_id = ?`);

function upsert(groupId, userId, name, role = 'member') {
  UPSERT.run(groupId, userId, name, role);
  return GET.get(groupId, userId);
}

function get(groupId, userId) {
  return GET.get(groupId, userId);
}

function byName(groupId, name) {
  return BY_NAME.get(groupId, name);
}

function list(groupId) {
  return LIST.all(groupId);
}

function listActive(groupId) {
  return LIST_ACTIVE.all(groupId);
}

function setStatus(groupId, userId, status) {
  SET_STATUS.run(status, groupId, userId);
}

function setRole(groupId, userId, role) {
  SET_ROLE.run(role, groupId, userId);
}

function rename(groupId, userId, name) {
  RENAME.run(name, groupId, userId);
}

function remove(groupId, userId) {
  DELETE.run(groupId, userId);
}

module.exports = {
  upsert,
  get,
  byName,
  list,
  listActive,
  setStatus,
  setRole,
  rename,
  remove,
};
