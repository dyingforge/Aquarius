/**
 * Time helpers. Aquarius schedules in a fixed IANA zone (default Asia/Shanghai) and
 * stores every persisted timestamp as an ISO-8601 UTC string.
 */

export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

export interface ZonedClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export function zonedClock(date: Date, timeZone: string = DEFAULT_TIME_ZONE): ZonedClock {
  const parts = zonedFormatter(timeZone).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part ? Number(part.value) : 0;
  };
  // `hour12: false` can still yield hour 24 for midnight in some ICU versions.
  const hour = read('hour') % 24;
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour,
    minute: read('minute'),
    second: read('second'),
  };
}

/** Milliseconds to add to a UTC instant to obtain the zone's wall-clock reading. */
export function zoneOffsetMs(date: Date, timeZone: string = DEFAULT_TIME_ZONE): number {
  const clock = zonedClock(date, timeZone);
  const asUtc = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Instant corresponding to a wall-clock time in `timeZone`. */
export function instantAtZonedTime(clock: ZonedClock, timeZone: string = DEFAULT_TIME_ZONE): Date {
  const naive = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second);
  let instant = naive - zoneOffsetMs(new Date(naive), timeZone);
  // Re-check once: the offset can differ across a DST boundary.
  const corrected = naive - zoneOffsetMs(new Date(instant), timeZone);
  if (corrected !== instant) instant = corrected;
  return new Date(instant);
}

/** `YYYY-MM-DD` in the given zone — the canonical "natural day" key. */
export function dayKey(date: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  const clock = zonedClock(date, timeZone);
  return `${clock.year.toString().padStart(4, '0')}-${clock.month.toString().padStart(2, '0')}-${clock.day
    .toString()
    .padStart(2, '0')}`;
}

export function monthKey(date: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  const clock = zonedClock(date, timeZone);
  return `${clock.year.toString().padStart(4, '0')}-${clock.month.toString().padStart(2, '0')}`;
}

export function yearKey(date: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  return zonedClock(date, timeZone).year.toString().padStart(4, '0');
}

/** The next occurrence of `hour:minute` in `timeZone`, strictly after `now`. */
export function nextDailyRun(
  now: Date,
  options: { hour: number; minute?: number; timeZone?: string },
): Date {
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const minute = options.minute ?? 0;
  const clock = zonedClock(now, timeZone);
  const today = instantAtZonedTime(
    { ...clock, hour: options.hour, minute, second: 0 },
    timeZone,
  );
  if (today.getTime() > now.getTime()) return today;
  const tomorrowClock = { ...clock, day: clock.day + 1, hour: options.hour, minute, second: 0 };
  return instantAtZonedTime(tomorrowClock, timeZone);
}

/** The most recent occurrence of `hour:minute` in `timeZone` at or before `now`. */
export function lastDailyRun(
  now: Date,
  options: { hour: number; minute?: number; timeZone?: string },
): Date {
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const minute = options.minute ?? 0;
  const clock = zonedClock(now, timeZone);
  const today = instantAtZonedTime({ ...clock, hour: options.hour, minute, second: 0 }, timeZone);
  if (today.getTime() <= now.getTime()) return today;
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayClock = zonedClock(yesterday, timeZone);
  return instantAtZonedTime(
    { ...yesterdayClock, hour: options.hour, minute, second: 0 },
    timeZone,
  );
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function isoFrom(date: Date): string {
  return date.toISOString();
}

export function parseIso(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ISO timestamp: ${value}`);
  return date;
}

export function minutesFromNow(minutes: number, from: Date = new Date()): Date {
  return new Date(from.getTime() + minutes * 60 * 1000);
}

export function secondsBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 1000);
}
