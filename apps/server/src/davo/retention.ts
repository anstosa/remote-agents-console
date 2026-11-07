export const DAVO_RETENTION_TIME_ZONE = 'America/Los_Angeles';
export const DAVO_SWEEP_HOUR = 3;
export const DAVO_RETAINED_CALENDAR_DAYS = 3;

export type DavoRetentionWindow = {
  sweepDate: string;
  retainedFrom: string;
  nextSweepAt: string;
};

type LocalParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

// format exact los angeles calendar parts
const localFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: DAVO_RETENTION_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

// normalize supported clock inputs
function asDate(value: Date | string | number): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  // reject an invalid clock value
  if (!Number.isFinite(date.getTime())) throw new TypeError('invalid davo clock value');
  return date;
}

// read local calendar parts without process timezone
function localParts(value: Date): LocalParts {
  const values: Record<string, number> = {};
  // collect only numeric date fields
  for (const part of localFormatter.formatToParts(value)) {
    // skip literals and unrelated fields
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return { year: values.year, month: values.month, day: values.day, hour: values.hour, minute: values.minute, second: values.second };
}

// render one local calendar date
function dateKey(parts: Pick<LocalParts, 'year' | 'month' | 'day'>): string {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

// shift a calendar date without timezone arithmetic
function shiftDate(parts: Pick<LocalParts, 'year' | 'month' | 'day'>, days: number): Pick<LocalParts, 'year' | 'month' | 'day'> {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

// resolve a local wall time to its unique instant
function localInstant(parts: Pick<LocalParts, 'year' | 'month' | 'day'>, hour: number): Date {
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, hour, 0, 0, 0);
  let candidate = wall;
  // converge on the zone offset at the requested wall time
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = localParts(new Date(candidate));
    const observedWall = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second, 0);
    const corrected = candidate + wall - observedWall;
    // stop after the offset stabilizes
    if (corrected === candidate) break;
    candidate = corrected;
  }
  const resolved = new Date(candidate);
  const observed = localParts(resolved);
  // fail rather than guess a skipped or ambiguous wall time
  if (observed.year !== parts.year || observed.month !== parts.month || observed.day !== parts.day || observed.hour !== hour || observed.minute !== 0 || observed.second !== 0) {
    throw new RangeError('unable to resolve davo retention wall time');
  }
  return resolved;
}

// compute the required completed sweep and next alarm
export function retentionWindow(now: Date | string | number): DavoRetentionWindow {
  const instant = asDate(now);
  const current = localParts(instant);
  const currentDate = { year: current.year, month: current.month, day: current.day };
  const sweep = current.hour >= DAVO_SWEEP_HOUR ? currentDate : shiftDate(currentDate, -1);
  const retained = shiftDate(sweep, -(DAVO_RETAINED_CALENDAR_DAYS - 1));
  const next = shiftDate(sweep, 1);
  return {
    sweepDate: dateKey(sweep),
    retainedFrom: localInstant(retained, 0).toISOString(),
    nextSweepAt: localInstant(next, DAVO_SWEEP_HOUR).toISOString()
  };
}

// expire one anchor after three complete local dates
export function expiryForAnchor(anchor: Date | string | number): string {
  const parts = localParts(asDate(anchor));
  return localInstant(shiftDate(parts, DAVO_RETAINED_CALENDAR_DAYS), DAVO_SWEEP_HOUR).toISOString();
}

// render the anchor's los angeles local date
export function localDateForInstant(value: Date | string | number): string {
  return dateKey(localParts(asDate(value)));
}
