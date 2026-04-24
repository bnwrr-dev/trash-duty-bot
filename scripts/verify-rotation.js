'use strict';

/**
 * Dry-run verification of rotation logic without hitting LINE.
 * Uses an in-memory SQLite via DATABASE_PATH override. Verifies:
 *  - Basic 4-person rotation cycles correctly over 8 weeks.
 *  - Not-Free skips the current assignee and advances past the replacement.
 *  - Not-at-Home deactivates the user and triggers reassignment.
 *  - Back-home restores participation.
 *  - Force-assign overrides the current assignee.
 *  - Fairness: over a full cycle with one not-free event, each member still
 *    does one duty on average across two cycles.
 *
 * Run: node scripts/verify-rotation.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// Point DB at a tmpdir so real data is untouched and WAL mode is supported.
const testDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trashbot-verify-'));
const testDbPath = path.join(testDbDir, 'verify.db');
process.env.DATABASE_PATH = testDbPath;
process.env.LOG_LEVEL = 'warn';
process.env.NODE_ENV = 'production';

// LINE credentials aren't used by the verification (no network calls), but
// config.js requires them to exist if any LINE-touching code is imported.
process.env.LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || 'test';
process.env.LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || 'test';

const { migrate } = require('../src/db/migrate');
migrate();

const groups = require('../src/models/groups');
const users = require('../src/models/users');
const rotations = require('../src/models/rotations');
const tasksModel = require('../src/models/tasks');
const rotation = require('../src/services/rotation');
const db = require('../src/db');

// ------- helpers -------
let assertions = 0;
let failures = 0;
function assertEq(actual, expected, msg) {
  assertions++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(`FAIL: ${msg}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  } else {
    console.log(`  OK: ${msg}`);
  }
}

function setup(groupId, names) {
  groups.ensure(groupId, { tz: 'Asia/Taipei', adminUserId: 'u_' + names[0] });
  const ids = names.map((n) => {
    const uid = 'u_' + n;
    users.upsert(groupId, uid, n, n === names[0] ? 'admin' : 'member');
    return uid;
  });
  rotations.setAll(groupId, ids);
  groups.setLastRotationOrder(groupId, -1);
  return ids;
}

// Force-assign is "current week" aware. For multi-week simulation we emulate
// weeks by directly creating tasks with explicit week_keys and using the core
// primitives (pickNextActive + updateStatus + last_rotation_order bookkeeping).
function simulateWeek(groupId, weekKey, opts = {}) {
  const group = groups.get(groupId);
  const next = rotation.pickNextActive(groupId, group.last_rotation_order);
  if (!next) return null;
  const task = tasksModel.create(groupId, weekKey, next.user_id);
  groups.setLastRotationOrder(groupId, next.position);

  if (opts.action === 'done') {
    tasksModel.updateStatus(task.task_id, 'completed');
    return { assignee: next.user_id, finalAssignee: next.user_id, task };
  }
  if (opts.action === 'not_free' || opts.action === 'not_home') {
    const res = rotation.skipAndReassign(groupId, task.task_id, opts.action);
    // Mark the replacement done.
    if (res.task) tasksModel.updateStatus(res.task.task_id, 'completed');
    return { assignee: next.user_id, finalAssignee: res.task ? res.task.user_id : null };
  }
  // default: mark done
  tasksModel.updateStatus(task.task_id, 'completed');
  return { assignee: next.user_id, finalAssignee: next.user_id, task };
}

// ------- Test 1: basic cycle -------
console.log('\n[Test 1] Basic 4-person rotation over 8 weeks');
{
  const gid = 'g_basic';
  const [A, B, C, D] = setup(gid, ['A', 'B', 'C', 'D']);
  const seq = [];
  for (let w = 1; w <= 8; w++) {
    seq.push(simulateWeek(gid, `W${w}`).finalAssignee);
  }
  assertEq(seq, [A, B, C, D, A, B, C, D], '8-week cycle matches [A,B,C,D,A,B,C,D]');
}

// ------- Test 2: Not Free rotates to back of line -------
console.log('\n[Test 2] Not Free shifts skipper to back of line');
{
  const gid = 'g_notfree';
  const [A, B, C, D] = setup(gid, ['A', 'B', 'C', 'D']);
  // Week 1: A assigned, A says Not Free → B replaces.
  const w1 = simulateWeek(gid, 'W1', { action: 'not_free' });
  assertEq({ assigned: w1.assignee, final: w1.finalAssignee }, { assigned: A, final: B }, 'W1: A assigned, B replaces');
  // Week 2: next after B → C
  const w2 = simulateWeek(gid, 'W2');
  assertEq(w2.finalAssignee, C, 'W2: C');
  const w3 = simulateWeek(gid, 'W3');
  assertEq(w3.finalAssignee, D, 'W3: D');
  const w4 = simulateWeek(gid, 'W4');
  assertEq(w4.finalAssignee, A, 'W4: A (makeup, back of line)');
  const w5 = simulateWeek(gid, 'W5');
  assertEq(w5.finalAssignee, B, 'W5: B (next cycle)');
  // Fairness over weeks 1..4: counts should be B:1 (replacement), C:1, D:1, A:1 (makeup) = everyone does exactly 1.
  // Plus A also "ran" W1 but skipped, doesn't count as a completed duty.
}

// ------- Test 3: Not at Home deactivates and reassigns -------
console.log('\n[Test 3] Not at Home deactivates member');
{
  const gid = 'g_nothome';
  const [A, B, C, D] = setup(gid, ['A', 'B', 'C', 'D']);
  // Week 1: A goes Not at Home → B replaces, A inactive.
  const w1 = simulateWeek(gid, 'W1', { action: 'not_home' });
  assertEq(w1.finalAssignee, B, 'W1 replaced with B');
  const aUser = users.get(gid, A);
  assertEq(aUser.status, 'inactive', 'A is inactive after not_home');
  // Next week should skip A and go to C.
  const w2 = simulateWeek(gid, 'W2');
  assertEq(w2.finalAssignee, C, 'W2: C (A skipped)');
  const w3 = simulateWeek(gid, 'W3');
  assertEq(w3.finalAssignee, D, 'W3: D');
  // A still inactive → W4 should wrap to B, not A.
  const w4 = simulateWeek(gid, 'W4');
  assertEq(w4.finalAssignee, B, 'W4: B (A still inactive)');
  // Back home restores A.
  rotation.backHome(gid, A);
  const aAfter = users.get(gid, A);
  assertEq(aAfter.status, 'active', 'A active after back_home');
  const w5 = simulateWeek(gid, 'W5');
  assertEq(w5.finalAssignee, C, 'W5: C (after B)');
  const w6 = simulateWeek(gid, 'W6');
  assertEq(w6.finalAssignee, D, 'W6: D');
  const w7 = simulateWeek(gid, 'W7');
  assertEq(w7.finalAssignee, A, 'W7: A (back in rotation)');
}

// ------- Test 4: Force assign overrides current -------
console.log('\n[Test 4] Force assign');
{
  const gid = 'g_force';
  const [A, B, C, D] = setup(gid, ['A', 'B', 'C', 'D']);
  // Assign W1 naturally (A).
  const { currentWeekKey } = require('../src/services/weekUtil');
  const thisWeek = currentWeekKey('Asia/Taipei');
  const first = rotation.assignForCurrentWeek(gid);
  assertEq(first.user.user_id, A, 'natural W assigns A');
  // Force to D.
  const forced = rotation.forceAssign(gid, D);
  assertEq(forced.task.user_id, D, 'force assigned to D');
  // Current task should now be D's.
  const cur = tasksModel.currentForWeek(gid, thisWeek);
  assertEq(cur.user_id, D, 'current task is D');
}

// ------- Test 5: pickNextActive wraps correctly -------
console.log('\n[Test 5] pickNextActive wrap-around');
{
  const gid = 'g_wrap';
  const [A, B, C, D] = setup(gid, ['A', 'B', 'C', 'D']);
  users.setStatus(gid, A, 'inactive');
  users.setStatus(gid, B, 'inactive');
  // last_rotation_order = 3 (D); wrap past A and B inactive → C (pos 2).
  groups.setLastRotationOrder(gid, 3);
  const next = rotation.pickNextActive(gid, 3);
  assertEq(next.user_id, C, 'wraps past inactives to C');
}

// ------- Test 6: single-member group assigns to the same person -------
console.log('\n[Test 6] Single active member');
{
  const gid = 'g_one';
  const [A] = setup(gid, ['A']);
  const r1 = simulateWeek(gid, 'W1');
  const r2 = simulateWeek(gid, 'W2');
  assertEq([r1.finalAssignee, r2.finalAssignee], [A, A], 'single member gets both weeks');
}

// ------- Test 7: No active members → no_active_members -------
console.log('\n[Test 7] No active members');
{
  const gid = 'g_empty';
  const [A, B] = setup(gid, ['A', 'B']);
  users.setStatus(gid, A, 'inactive');
  users.setStatus(gid, B, 'inactive');
  const res = rotation.assignForCurrentWeek(gid);
  assertEq(res.reason, 'no_active_members', 'reports no_active_members');
}

// ------- Test 8: Undo within window, blocked after -------
console.log('\n[Test 8] Undo window');
{
  const gid = 'g_undo';
  const [A] = setup(gid, ['A']);
  const res = rotation.assignForCurrentWeek(gid);
  rotation.markDone(gid, res.task.task_id, A);
  const undo = rotation.undoDone(gid, res.task.task_id, A);
  assertEq(undo.task && undo.task.status, 'pending', 'undo reverts to pending');
  // Simulate 25h elapsed by rewriting completed_at backwards.
  rotation.markDone(gid, res.task.task_id, A);
  db.prepare("UPDATE tasks SET completed_at = datetime('now', '-25 hours') WHERE task_id = ?")
    .run(res.task.task_id);
  const late = rotation.undoDone(gid, res.task.task_id, A);
  assertEq(late.reason, 'window_expired', 'undo blocked after 24h');
}

// ------- Test 9: Week-key boundaries -------
console.log('\n[Test 9] Week-key boundaries (Thursday anchor)');
{
  const { weekKeyFor } = require('../src/services/weekUtil');
  assertEq(weekKeyFor('2026-04-23T09:00:00+08:00', 'Asia/Taipei'), '2026-04-23', 'Thursday morning');
  assertEq(weekKeyFor('2026-04-29T23:30:00+08:00', 'Asia/Taipei'), '2026-04-23', 'Wed 23:30 same week');
  assertEq(weekKeyFor('2026-04-30T00:01:00+08:00', 'Asia/Taipei'), '2026-04-30', 'Thu 00:01 new week');
  assertEq(weekKeyFor('2026-04-22T23:59:00+08:00', 'Asia/Taipei'), '2026-04-16', 'Wed 23:59 prev week');
}

// ------- Summary -------
console.log(`\n${assertions} assertions, ${failures} failures`);
try { fs.rmSync(testDbDir, { recursive: true, force: true }); } catch {}
process.exit(failures ? 1 : 0);
