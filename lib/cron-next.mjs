/**
 * cron-next.mjs — zero-dependency 5-field cron parser + next-occurrence engine.
 *
 * Supports: `*`, step (slash-n), ranges (a-b), lists (a,b), month/day-of-week
 * names (jan-dec, sun-sat), optional `?` as synonym of `*` for dom/dow, and
 * `0 9 * * 1-5` style. When both day-of-month and day-of-week are
 * restricted (neither is `*`), a day matches if EITHER matches (Vixie cron
 * semantics). Timezone-aware: occurrences are computed in an IANA timezone
 * (or the local zone when tz is 'local'/omitted) via the Intl API.
 */

const MONTH_NAMES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const DAY_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

const FIELD_RANGES = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 },  // day of week (0 = sunday)
]

export class CronParseError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CronParseError'
  }
}

/** Parse one cron field into a Set of allowed values. */
function parseField(raw, range, names, fieldName) {
  const { min, max } = range
  const text = String(raw).trim().toLowerCase()
  if (text === '*' || text === '?') return { any: true, values: null }

  const values = new Set()
  for (const part of text.split(',')) {
    if (part === '') throw new CronParseError(`cron: empty list item in ${fieldName} field`)
    let step = 1
    let rangeText = part
    const slash = part.indexOf('/')
    if (slash !== -1) {
      const stepRaw = part.slice(slash + 1)
      if (stepRaw === '' || !/^\d+$/.test(stepRaw)) throw new CronParseError(`cron: bad step "${stepRaw}" in ${fieldName} field`)
      step = Number(stepRaw)
      if (step < 1) throw new CronParseError(`cron: step must be >= 1 in ${fieldName} field`)
      rangeText = part.slice(0, slash)
      if (rangeText === '') throw new CronParseError(`cron: empty range before step in ${fieldName} field`)
    }

    const resolve = (token) => {
      if (/^\d+$/.test(token)) return Number(token)
      if (names && names[token] !== undefined) return names[token]
      throw new CronParseError(`cron: unknown value "${token}" in ${fieldName} field`)
    }

    let lo, hi
    if (rangeText === '*') {
      lo = min
      hi = max
    } else {
      const dash = rangeText.indexOf('-')
      if (dash === -1) {
        lo = hi = resolve(rangeText)
      } else {
        lo = resolve(rangeText.slice(0, dash))
        hi = resolve(rangeText.slice(dash + 1))
      }
    }
    if (lo > hi) throw new CronParseError(`cron: range ${lo}-${hi} inverted in ${fieldName} field`)
    if (lo < min || hi > max) throw new CronParseError(`cron: value out of range ${lo}-${hi} (${min}..${max}) in ${fieldName} field`)
    for (let v = lo; v <= hi; v += step) values.add(v)
  }
  return { any: false, values }
}

/** Parse a full 5-field cron expression. */
export function parseCron(expression) {
  if (typeof expression !== 'string') throw new CronParseError('cron: expression must be a string')
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) throw new CronParseError(`cron: expected 5 fields, got ${fields.length} in "${expression}"`)
  const [minute, hour, dom, month, dow] = fields.map((f, i) =>
    parseField(f, FIELD_RANGES[i], i === 3 ? MONTH_NAMES : i === 4 ? DAY_NAMES : undefined,
      ['minute', 'hour', 'day-of-month', 'month', 'day-of-week'][i]))
  return {
    minute, hour, dom, month, dow,
    // Vixie semantics: both restricted → OR; one restricted → the restricted one governs.
    domRestricted: !dom.any,
    dowRestricted: !dow.any,
    bothRestricted: !dom.any && !dow.any,
  }
}

function dayMatches(cron, day, month, weekday) {
  const domOk = cron.dom.any || cron.dom.values.has(day)
  const dowOk = cron.dow.any || cron.dow.values.has(weekday)
  if (cron.bothRestricted) return domOk || dowOk
  if (cron.domRestricted) return domOk
  if (cron.dowRestricted) return dowOk
  return true
}

const DAYS_IN_MONTH = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate()

// ---- timezone helpers (Intl-based, no deps) ----

function formatter(tz, extra) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz === 'local' || !tz ? undefined : tz,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    ...extra,
  })
}

/** Split a UTC instant into parts as seen in `tz`. */
function zonedParts(tz, utcMs) {
  const fmt = formatter(tz)
  const p = {}
  for (const { type, value } of fmt.formatToParts(new Date(utcMs))) p[type] = value
  const hour = p.hour === '24' ? '0' : p.hour // some locales emit 24:xx at midnight
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(hour), minute: Number(p.minute), second: Number(p.second),
  }
}

/** UTC offset (minutes) of `tz` at instant `utcMs`. local = utc + offset. */
function tzOffsetMinutes(tz, utcMs) {
  const p = zonedParts(tz, utcMs)
  const naive = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return Math.round((naive - utcMs) / 60000)
}

/**
 * Convert naive zoned calendar parts (y/m/d/h/mi in `tz`) to a UTC instant.
 * Iteratively corrects for the timezone offset (converges in <= 3 passes,
 * DST-safe).
 */
export function zonedToUtc(tz, y, m, d, h, mi, s = 0) {
  let utc = Date.UTC(y, m - 1, d, h, mi, s)
  for (let i = 0; i < 3; i++) {
    const corrected = Date.UTC(y, m - 1, d, h, mi, s) - tzOffsetMinutes(tz, utc) * 60000
    if (corrected === utc) break
    utc = corrected
  }
  return utc
}

/**
 * Compute the next occurrence of `cron` strictly after `afterMs` (a UTC
 * instant), in timezone `tz`. Returns a UTC epoch ms, or null if no
 * occurrence exists within a 4-year horizon (e.g. Feb 30).
 */
export function nextCronAfter(cron, afterMs, tz) {
  // Start at the next full minute in tz.
  let cur = zonedParts(tz, afterMs)
  let carry = 0
  let m = cur.minute + 1
  if (m > 59) { m = 0; carry = 1 }
  let h = cur.hour + carry
  if (h > 23) { h = 0; carry = 1 } else carry = 0
  let d = cur.day + carry
  let mo = cur.month
  let y = cur.year
  if (d > DAYS_IN_MONTH(y, mo)) { d = 1; mo += 1 }
  if (mo > 12) { mo = 1; y += 1 }

  let guard = 0
  const deadline = afterMs + 4 * 366 * 24 * 3600 * 1000
  for (;;) {
    if (++guard > 20000) return null
    const t = zonedToUtc(tz, y, mo, d, h, m)
    if (t > deadline) return null

    if (!cron.month.any && !cron.month.values.has(mo)) {
      // Advance to the 1st of the next allowed month (or next year).
      let next = null
      for (let mm = mo + 1; mm <= 12; mm++) if (cron.month.values.has(mm)) { next = mm; break }
      if (next === null) { y += 1; next = 1 }
      mo = next; d = 1; h = 0; m = 0
      continue
    }

    const weekday = new Date(t).getUTCDay()
    if (!dayMatches(cron, d, mo, weekday)) {
      d += 1
      if (d > DAYS_IN_MONTH(y, mo)) { d = 1; mo += 1 }
      if (mo > 12) { mo = 1; y += 1 }
      h = 0; m = 0
      continue
    }

    if (!cron.hour.any && !cron.hour.values.has(h)) {
      let next = null
      for (let hh = h + 1; hh <= 23; hh++) if (cron.hour.values.has(hh)) { next = hh; break }
      if (next === null) {
        d += 1
        if (d > DAYS_IN_MONTH(y, mo)) { d = 1; mo += 1 }
        if (mo > 12) { mo = 1; y += 1 }
        next = 0
      }
      h = next; m = 0
      continue
    }

    if (!cron.minute.any && !cron.minute.values.has(m)) {
      let next = null
      for (let mm = m + 1; mm <= 59; mm++) if (cron.minute.values.has(mm)) { next = mm; break }
      if (next === null) {
        h += 1
        if (h > 23) {
          h = 0; d += 1
          if (d > DAYS_IN_MONTH(y, mo)) { d = 1; mo += 1 }
          if (mo > 12) { mo = 1; y += 1 }
        }
        next = 0
      }
      m = next
      continue
    }

    return t
  }
}

/**
 * List the next `count` occurrences of a cron expression after `afterMs`.
 * @returns array of ISO 8601 UTC strings.
 */
export function cronOccurrences(expression, tz, afterMs = Date.now(), count = 5) {
  const cron = parseCron(expression)
  const out = []
  let cursor = afterMs
  for (let i = 0; i < count; i++) {
    const next = nextCronAfter(cron, cursor, tz)
    if (next === null) break
    out.push(new Date(next).toISOString())
    cursor = next
  }
  return out
}

/** Parse an interval expression like "90s" / "30m" / "2h" / "1d" into seconds. */
export function parseInterval(expression) {
  const text = String(expression ?? '').trim().toLowerCase()
  const match = /^(\d+)(s|m|h|d)$/.exec(text)
  if (!match) throw new CronParseError(`interval: expected <n>s|m|h|d, got "${expression}"`)
  const n = Number(match[1])
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }[match[2]]
  const seconds = n * unit
  if (seconds < 60) throw new CronParseError('interval: minimum interval is 60s')
  return seconds
}
