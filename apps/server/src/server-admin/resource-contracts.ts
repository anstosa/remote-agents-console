// one attached filesystem or volume, including media whose usage is unavailable
export type ResourceDisk = {
  mount: string;
  usedBytes: number | null;
  totalBytes: number | null;
};

// one operating-system resource boundary
export type ResourceUsage = {
  cpuPercent: number | null;
  memory: { usedBytes: number; totalBytes: number } | null;
  disks: ResourceDisk[];
  diskError?: string;
};

// one on-demand server sample, with WSL kept separate from its Windows host
export type ResourceSnapshot = {
  sampledAt: string;
  host: ResourceUsage | null;
  wsl?: ResourceUsage;
  errors?: string[];
};

// recognize one plain JSON object
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

// recognize one non-negative finite byte or percentage value
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

// recognize unavailable or finite resource values
const nullableFinite = (value: unknown): value is number | null => value === null || finite(value);

// validate one disk record from the isolated collector
const resourceDisk = (value: unknown): value is ResourceDisk => {
  // require the complete stable disk shape
  if (!object(value) || typeof value.mount !== 'string') return false;
  // keep unavailable usage consistently paired
  if (!nullableFinite(value.usedBytes) || !nullableFinite(value.totalBytes) || (value.usedBytes === null) !== (value.totalBytes === null)) return false;
  return value.usedBytes === null || value.totalBytes === null || value.usedBytes <= value.totalBytes;
};

// validate one OS resource boundary from the isolated collector
const resourceUsage = (value: unknown): value is ResourceUsage => {
  // require bounded CPU and disk records
  if (!object(value) || !Array.isArray(value.disks) || !value.disks.every(resourceDisk)) return false;
  // bound available CPU readings
  if (value.cpuPercent !== null && (!finite(value.cpuPercent) || value.cpuPercent > 100)) return false;
  // accept an explicitly unavailable memory reading
  if (value.memory === null) return value.diskError === undefined || typeof value.diskError === 'string';
  // require one internally consistent memory reading
  if (!object(value.memory) || !finite(value.memory.usedBytes) || !finite(value.memory.totalBytes) || value.memory.usedBytes > value.memory.totalBytes) return false;
  return value.diskError === undefined || typeof value.diskError === 'string';
};

// validate the complete API response before publishing or rendering it
export const isResourceSnapshot = (value: unknown): value is ResourceSnapshot => {
  // require a parseable timestamp and host boundary
  if (!object(value) || typeof value.sampledAt !== 'string' || Number.isNaN(Date.parse(value.sampledAt))) return false;
  // retain explicit host unavailability
  if (value.host !== null && !resourceUsage(value.host)) return false;
  // validate the optional WSL boundary
  if (value.wsl !== undefined && !resourceUsage(value.wsl)) return false;
  // validate human-readable sampling errors
  if (value.errors !== undefined && (!Array.isArray(value.errors) || !value.errors.every(error => typeof error === 'string'))) return false;
  return true;
};
