import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseCron, nextCronAfter, cronOccurrences, parseInterval,
  zonedToUtc, CronParseError,
} from '../lib/cron-next.mjs'

const UTC = 'UTC'

test('parses basic fields', () => {
  const c = parseCron('*/15 0 1,15 * 1-5')
  assert.equal(c.minute.values.has(0), true)
  assert.equal(c.minute.values.has(15), true)
  assert.equal(c.minute.values.has(45), true)
  assert.equal(c.hour.values.has(0), true)
  assert.equal(c.dom.values.has(1), true)
  assert.equal(c.dom.values.has(15), true)
  assert.equal(c.dow.values.has(1), true)
  assert.equal(c.dow.values.has(5), true)
})

test('parses names and ?', () => {
  const c = parseCron('0 9 * jan mon')
  assert.equal(c.month.values.has(1), true)
  assert.equal(c.dow.values.has(1), true)
  const q = parseCron('0 9 ? * *')
  assert.equal(q.dom.any, true)
})

test('rejects invalid expressions', () => {
  assert.throws(() => parseCron('0 9 * *'), CronParseError)
  assert.throws(() => parseCron('60 0 * * *'), CronParseError)
  assert.throws(() => parseCron('0 24 * * *'), CronParseError)
  assert.throws(() => parseCron('0 0 32 * *'), CronParseError)
  assert.throws(() => parseCron('0 0 * 13 *'), CronParseError)
  assert.throws(() => parseCron('5-1 0 * * *'), CronParseError)
  assert.throws(() => parseCron('*/0 0 * * *'), CronParseError)
  assert.throws(() => parseCron('0 0 * * foo'), CronParseError)
})

test('next: every minute', () => {
  const c = parseCron('* * * * *')
  const after = Date.UTC(2026, 7, 15, 10, 0, 30)
  assert.equal(nextCronAfter(c, after, UTC), Date.UTC(2026, 7, 15, 10, 1, 0))
})

test('next: hourly at :15', () => {
  const c = parseCron('15 * * * *')
  const after = Date.UTC(2026, 7, 15, 10, 0, 0)
  assert.equal(nextCronAfter(c, after, UTC), Date.UTC(2026, 7, 15, 10, 15, 0))
  // already past :15 this hour → next hour
  const after2 = Date.UTC(2026, 7, 15, 10, 15, 0)
  assert.equal(nextCronAfter(c, after2, UTC), Date.UTC(2026, 7, 15, 11, 15, 0))
})

test('next: daily at 09:00, weekday-restricted skips weekend', () => {
  // 2026-08-15 is a Saturday
  const c = parseCron('0 9 * * 1-5')
  const after = Date.UTC(2026, 7, 15, 0, 0, 0) // Saturday
  const next = nextCronAfter(c, after, UTC)
  const d = new Date(next)
  assert.equal(d.getUTCDay(), 1) // Monday
  assert.equal(d.getUTCHours(), 9)
  assert.equal(d.getUTCDate(), 17)
})

test('next: monthly on the 1st', () => {
  const c = parseCron('0 0 1 * *')
  const after = Date.UTC(2026, 7, 15, 12, 0, 0)
  assert.equal(nextCronAfter(c, after, UTC), Date.UTC(2026, 8, 1, 0, 0, 0))
})

test('next: year rollover (Dec 31 → Jan 1)', () => {
  const c = parseCron('0 0 1 1 *')
  const after = Date.UTC(2026, 11, 31, 23, 0, 0)
  assert.equal(nextCronAfter(c, after, UTC), Date.UTC(2027, 0, 1, 0, 0, 0))
})

test('next: Feb 29 only in leap years', () => {
  const c = parseCron('0 0 29 2 *')
  const after = Date.UTC(2026, 5, 1, 0, 0, 0)
  assert.equal(nextCronAfter(c, after, UTC), Date.UTC(2028, 1, 29, 0, 0, 0))
})

test('next: dom/dow both restricted uses OR semantics', () => {
  // Runs on the 13th OR on Friday
  const c = parseCron('0 0 13 * 5')
  const after = Date.UTC(2026, 7, 1, 0, 0, 0) // Aug 1 2026 = Saturday
  // Aug 7 (Fri) is next
  assert.equal(nextCronAfter(c, after, UTC), Date.UTC(2026, 7, 7, 0, 0, 0))
})

test('occurrences: 5 upcoming daily', () => {
  const out = cronOccurrences('0 9 * * *', UTC, Date.UTC(2026, 7, 15, 8, 0, 0), 5)
  assert.equal(out.length, 5)
  assert.equal(out[0], '2026-08-15T09:00:00.000Z')
  assert.equal(out[4], '2026-08-19T09:00:00.000Z')
})

test('timezone: Asia/Shanghai 09:00 = 01:00Z', () => {
  const out = cronOccurrences('0 9 * * *', 'Asia/Shanghai', Date.UTC(2026, 7, 15, 0, 0, 0), 1)
  assert.equal(out[0], '2026-08-15T01:00:00.000Z')
})

test('timezone: America/New_York (EDT, UTC-4) 09:00 = 13:00Z', () => {
  const out = cronOccurrences('0 9 * * *', 'America/New_York', Date.UTC(2026, 7, 15, 0, 0, 0), 1)
  assert.equal(out[0], '2026-08-15T13:00:00.000Z')
})

test('timezone: Asia/Shanghai dow-restricted cron fires on local Monday (weekday uses job tz, not UTC)', () => {
  // 2026-08-17 is a Monday in Asia/Shanghai; in UTC the same instant is
  // Sunday 2026-08-16T16:00Z. The old code computed the weekday from the UTC
  // instant and skipped the whole local Monday, returning null forever.
  const after = Date.UTC(2026, 7, 15, 0, 0, 0) // Sat 2026-08-15
  const out = cronOccurrences('0 9 * * 1', 'Asia/Shanghai', after, 1)
  assert.equal(out.length, 1)
  assert.equal(out[0], '2026-08-17T01:00:00.000Z') // local Mon 2026-08-17 09:00
})

test('timezone: Asia/Shanghai dow-restricted nextCronAfter non-null', () => {
  const c = parseCron('0 9 * * 1')
  const next = nextCronAfter(c, Date.now(), 'Asia/Shanghai')
  assert.ok(next !== null, 'must find a next Monday 09:00 in Asia/Shanghai')
  assert.equal(new Date(next).getUTCDay(), 1)
  assert.equal(new Date(next).getUTCHours(), 1) // 09:00 +08
})

test('timezone: UTC dow-restricted still correct (regression)', () => {
  const out = cronOccurrences('0 9 * * 1', 'UTC', Date.UTC(2026, 7, 15, 0, 0, 0), 1)
  assert.equal(out[0], '2026-08-17T09:00:00.000Z')
})

test('zonedToUtc roundtrip', () => {
  const utc = zonedToUtc('Asia/Shanghai', 2026, 8, 15, 9, 0)
  assert.equal(utc, Date.UTC(2026, 7, 15, 1, 0, 0))
})

test('interval parsing', () => {
  assert.equal(parseInterval('90s'), 90)
  assert.equal(parseInterval('30m'), 1800)
  assert.equal(parseInterval('2h'), 7200)
  assert.equal(parseInterval('1d'), 86400)
  assert.throws(() => parseInterval('30s'), CronParseError) // below minimum
  assert.throws(() => parseInterval('10x'), CronParseError)
  assert.throws(() => parseInterval(''), CronParseError)
})

test('invalid timezone is rejected at call time', () => {
  assert.throws(() => cronOccurrences('0 9 * * *', 'Mars/Olympus', Date.now(), 1))
})
