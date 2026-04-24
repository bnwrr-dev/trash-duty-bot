'use strict';

const db = require('./index');
const logger = require('../logger');

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );
  `);

  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get();
  const current = row ? row.version : 0;

  if (current < 1) {
    db.exec(`
      BEGIN;

      CREATE TABLE groups (
        group_id        TEXT PRIMARY KEY,           -- LINE groupId
        tz              TEXT NOT NULL,              -- IANA tz, e.g. Asia/Taipei
        admin_user_id   TEXT,                       -- LINE userId of the admin; set on setup
        paused          INTEGER NOT NULL DEFAULT 0, -- 0/1
        last_rotation_order INTEGER NOT NULL DEFAULT -1, -- last position used for assignment
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE users (
        group_id   TEXT NOT NULL,
        user_id    TEXT NOT NULL,                     -- LINE userId
        name       TEXT NOT NULL,                     -- display name at join time
        role       TEXT NOT NULL DEFAULT 'member',    -- 'admin' | 'member'
        status     TEXT NOT NULL DEFAULT 'active',    -- 'active' | 'inactive'
        joined_at  TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (group_id, user_id),
        FOREIGN KEY (group_id) REFERENCES groups(group_id) ON DELETE CASCADE
      );

      CREATE TABLE rotations (
        group_id    TEXT NOT NULL,
        user_id     TEXT NOT NULL,
        position    INTEGER NOT NULL,           -- 0-based index in rotation order
        PRIMARY KEY (group_id, user_id),
        FOREIGN KEY (group_id, user_id) REFERENCES users(group_id, user_id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX idx_rotations_position ON rotations(group_id, position);

      CREATE TABLE tasks (
        task_id         INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id        TEXT NOT NULL,
        week_key        TEXT NOT NULL,             -- YYYY-MM-DD of the Thursday that starts the week
        user_id         TEXT NOT NULL,             -- currently assigned user
        status          TEXT NOT NULL,             -- 'pending' | 'completed' | 'skipped' | 'overdue'
        assigned_at     TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at    TEXT,
        skipped_reason  TEXT,                      -- 'not_free' | 'not_home' | 'force_reassign'
        superseded_by   INTEGER,                   -- task_id that replaced this task when skipped
        FOREIGN KEY (group_id) REFERENCES groups(group_id) ON DELETE CASCADE,
        FOREIGN KEY (superseded_by) REFERENCES tasks(task_id)
      );
      CREATE INDEX idx_tasks_group_week ON tasks(group_id, week_key);
      CREATE INDEX idx_tasks_group_status ON tasks(group_id, status);

      CREATE TABLE history (
        history_id   INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id     TEXT NOT NULL,
        task_id      INTEGER,
        week_key     TEXT,
        user_id      TEXT,
        event        TEXT NOT NULL,        -- 'assigned' | 'completed' | 'not_free' | 'not_home' | 'back_home' | 'reminded' | 'overdue' | 'force_assigned' | 'paused' | 'resumed' | 'rotation_reset' | 'undone'
        detail       TEXT,                  -- free-form JSON or text
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_history_group ON history(group_id, created_at DESC);

      INSERT INTO schema_version (version) VALUES (1);
      COMMIT;
    `);
    logger.info('migrated to schema version 1');
  }
}

if (require.main === module) {
  migrate();
  logger.info('migration complete');
}

module.exports = { migrate };
