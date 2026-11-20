export type ProcStat = { pid: number; parentPid: number; startTime: string; comm: string; live: boolean };

// parse the lifetime independently of mutable command and cwd records
export function parseProcStat(raw: string, pid: number): ProcStat | undefined {
  const open = raw.indexOf('(');
  const close = raw.lastIndexOf(')');
  // the command can contain spaces and parentheses
  if (open < 0 || close <= open || raw.slice(0, open).trim() !== String(pid)) return undefined;
  const [state, parent, ...rest] = raw.slice(close + 1).trim().split(/\s+/u);
  const startTime = rest[17];
  // reject incomplete or malformed identity fields
  if (state === undefined || !/^[A-Za-z]$/u.test(state) || parent === undefined || !/^\d+$/u.test(parent) || !Number.isSafeInteger(Number(parent)) || startTime === undefined || !/^\d+$/u.test(startTime)) return undefined;
  return { pid, parentPid: Number(parent), startTime, comm: raw.slice(open + 1, close).trim(), live: state !== 'Z' && state !== 'X' && state !== 'x' };
}

// compare both sides of a metadata read before trusting its lifetime
export function sameLiveProcStat(before: ProcStat, after: ProcStat): boolean {
  return before.live && after.live && before.pid === after.pid && before.startTime === after.startTime && before.parentPid === after.parentPid && before.comm === after.comm;
}
