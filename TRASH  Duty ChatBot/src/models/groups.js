'use strict';

const db = require('../db');

const INSERT = db.prepare(`
  INSERT OR IGNORE INTO groups (group_id, tz, admin_user_id)
  VALUES (?, ?, ?)
`);

const GET = db.prepare(`SELECT * FROM groups WHERE group_id = ?`);

const UPDATE_ADMIN = db.prepare(`UPDATE groups SET admin_user_id = ? WHERE group_id = ?`);
const UPDATE_TZ = db.prepare(`UPDATE groups SET tz = ? WHERE group_id = ?`);
const UPDATE_PAUSED = db.prepare(`UPDATE groups SET paused = ? WHERE group_id = ?`);
const UPDATE_LAST_ROTATION = db.prepare(
  `UPDATE groups SET last_rotation_order = ? WHERE group_id = ?`
);

const ALL = db.prepare(`SELECT * FROM groups`);
const DELETE = db.prepare(`DELETE FROM groups WHERE group_id = ?`);

function ensure(groupId, { tz, adminUserId } = {}) {
  INSERT.run(groupId, tz || 'Asia/Taipei', adminUserId || null);
  return GET.get(groupId);
}

function get(groupId) {
  return GET.get(groupId);
}

function setAdmin(groupId, userId) {
  UPDATE_ADMIN.run(userId, groupId);
}

function setTz(groupId, tz) {
  UPDATE_TZ.run(tz, groupId);
}

function setPaused(groupId, paused) {
  UPDATE_PAUSED.run(paused ? 1 : 0, groupId);
}

function setLastRotationOrder(groupId, position) {
  UPDATE_LAST_ROTATION.run(position, groupId);
}

function all() {
  return ALL.all();
}

function remove(groupId) {
  DELETE.run(groupId);
}

module.exports = {
  ensure,
  get,
  setAdmin,
  setTz,
  setPaused,
  setLastRotationOrder,
  all,
  remove,
};
