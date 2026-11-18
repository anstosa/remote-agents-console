// format decimal capacities consistently across host and wsl
export const resourceBytes = (value: number): string => {
  const unit = Math.min(4, Math.floor(Math.log10(Math.max(1, value)) / 3));
  const capacity = value / 1000 ** unit;
  // round gb upward and retain one decimal for tb
  const display = unit === 3 ? Math.ceil(capacity) : capacity;
  return `${display.toLocaleString(undefined, { minimumFractionDigits: unit === 4 ? 1 : 0, maximumFractionDigits: unit === 3 ? 0 : 1 })} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`;
};

// round labels upward without changing bar positions or gauge averages
export const resourcePercent = (value: number): string => `${Math.ceil(value).toLocaleString()}%`;

// distinguish unavailable capacities from a settled zero reading
export const usagePercent = (used: number | null, total: number | null): number | null => used === null || total === null || total <= 0 ? null : used / total * 100;

// share strict usage thresholds across bars and gauges
export const resourceSeverityClass = (value: number): string => value > 90 ? ' critical' : value > 75 ? ' warning' : value > 50 ? ' elevated' : '';
