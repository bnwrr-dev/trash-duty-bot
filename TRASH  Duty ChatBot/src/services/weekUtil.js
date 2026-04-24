'use strict';

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * Returns the "week key" for a given date/time in a given timezone.
 * Our duty week runs Thursday 00:00 → Wednesday 23:59:59 in the group's tz.
 * The week key is the ISO date (YYYY-MM-DD) of the Thursday that starts the week.
 *
 * Examples (tz=Asia/Taipei):
 *   Thursday 2026-04-23 09:00 → "2026-04-23"
 *   Wednesday 2026-04-29 23:30 → "2026-04-23"
 *   Thursday 2026-04-30 00:01 → "2026-04-30"
 */
function weekKeyFor(date, tz) {
  const d = dayjs(date).tz(tz);
  const dayOfWeek = d.day(); // 0 (Sun) ... 6 (Sat); Thursday = 4
  const daysSinceThursday = (dayOfWeek - 4 + 7) % 7;
  const thursday = d.subtract(daysSinceThursday, 'day').startOf('day');
  return thursday.format('YYYY-MM-DD');
}

function currentWeekKey(tz) {
  return weekKeyFor(new Date(), tz);
}

function nowInTz(tz) {
  return dayjs().tz(tz);
}

module.exports = { weekKeyFor, currentWeekKey, nowInTz };
