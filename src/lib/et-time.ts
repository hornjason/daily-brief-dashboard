/**
 * Eastern Time (ET) to UTC conversion utilities.
 *
 * Handles EST/EDT transitions correctly using Intl.DateTimeFormat.
 * Replaces 6 copy-pasted nextEtXXXamUtc functions in background-scheduler.ts.
 *
 * Uses the "formatToParts" approach to derive the current ET offset:
 * 1. Get current time in ET timezone as component parts (year, month, day, hour, etc.)
 * 2. Construct "what those ET parts would be if interpreted as UTC"
 * 3. Compute offset = actual UTC ms - "ET treated as UTC" ms
 * 4. Apply that offset to the target ET time to get correct UTC
 *
 * This correctly handles EST (UTC-5) vs EDT (UTC-4) without hardcoding offsets.
 */

/**
 * Calculate the next occurrence of a specific ET (Eastern Time) time as UTC.
 *
 * @param hour - Hour in 24-hour format (0-23)
 * @param minute - Minute (0-59)
 * @param now - Optional reference time (defaults to current time)
 * @returns Next occurrence of the specified ET time as a UTC Date
 *
 * @example
 * // Next 2:00am ET
 * nextEtTimeUtc(2, 0)
 *
 * // Next 6:30am ET
 * nextEtTimeUtc(6, 30)
 */
export function nextEtTimeUtc(hour: number, minute: number, now?: Date): Date {
  const _now = now ?? new Date()

  // Derive ET UTC offset by comparing actual UTC ms with "ET time treated as UTC" ms.
  // This correctly handles EST vs EDT without hardcoding the offset.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })

  const p: Record<string, number> = {}
  for (const part of fmt.formatToParts(_now)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value)
  }

  // etOffsetMs = how many ms ahead UTC is vs ET local time
  const etAsIfUtcMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  const etOffsetMs = _now.getTime() - etAsIfUtcMs // e.g. 4*3600*1000 during EDT

  // "Today at [hour]:[minute] ET" expressed as UTC
  let target = new Date(Date.UTC(p.year, p.month - 1, p.day, hour, minute, 0) + etOffsetMs)

  // If already past, roll to tomorrow
  if (target.getTime() <= _now.getTime()) {
    target = new Date(target.getTime() + 24 * 60 * 60 * 1000)
  }

  return target
}

/**
 * Calculate the next occurrence of a specific ET time on a specific weekday.
 *
 * @param dayOfWeek - Day of week (0=Sunday, 1=Monday, ..., 6=Saturday)
 * @param hour - Hour in 24-hour format (0-23)
 * @param minute - Minute (0-59)
 * @param now - Optional reference time (defaults to current time)
 * @returns Next occurrence of the specified weekday+time as a UTC Date
 *
 * @example
 * // Next Sunday at 6:00am ET
 * nextEtWeekdayUtc(0, 6, 0)
 *
 * // Next Friday at 5:30pm ET
 * nextEtWeekdayUtc(5, 17, 30)
 */
export function nextEtWeekdayUtc(dayOfWeek: number, hour: number, minute: number, now?: Date): Date {
  const base = now ?? new Date()

  // Determine ET offset: UTC-5 (EST) or UTC-4 (EDT)
  const etOffsetMin = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  })
    .formatToParts(base)
    .find(p => p.type === 'timeZoneName')
    ?.value?.replace('GMT', '') ?? '-5'

  const offsetHours = parseInt(etOffsetMin, 10) || -5

  // Target: next [dayOfWeek] at [hour]:[minute] ET
  const candidate = new Date(base)

  // Find next occurrence of target weekday
  const currentDay = candidate.getDay()
  let daysUntilTarget = ((dayOfWeek - currentDay + 7) % 7)

  // If it's 0, we're on the target day today - try today first
  if (daysUntilTarget === 0) {
    // Set to target time on today
    candidate.setUTCHours(hour - offsetHours, minute, 0, 0)
    // If already past, go to next week
    if (candidate <= base) {
      daysUntilTarget = 7
      candidate.setUTCDate(candidate.getUTCDate() + 7)
    }
  } else {
    // Different day - jump to it
    candidate.setUTCDate(candidate.getUTCDate() + daysUntilTarget)
    candidate.setUTCHours(hour - offsetHours, minute, 0, 0)
  }

  return candidate
}
