// format binary capacities consistently across host and wsl
export const resourceBytes = (value: number): string => {
  const unit = Math.min(4, Math.floor(Math.log2(Math.max(1, value)) / 10));
  return `${(value / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`;
};

// use one precision for both the flyout bars and button gauges
export const resourcePercent = (value: number): string => `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;

// distinguish unavailable capacities from a settled zero reading
export const usagePercent = (used: number | null, total: number | null): number | null => used === null || total === null || total <= 0 ? null : used / total * 100;

// share thresholds across bars and gauges
export const resourceSeverityClass = (value: number): string => value >= 95 ? ' critical' : value >= 85 ? ' warning' : '';
