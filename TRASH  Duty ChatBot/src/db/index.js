'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { config } = require('../config');
const logger = require('../logger');

const dbPath = path.resolve(config.db.path);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

logger.info({ dbPath }, 'sqlite opened');

module.exports = db;
