import type { ResourceAverages } from './server-resource-cache.js';
import { resourcePercent, resourceSeverityClass } from './server-resource-values.js';

// center the strokes on the control edge and match its corner radius
const sides = [
  { metric: 'cpu', label: 'CPU', path: 'M 20 40 H 4.6 A 4.6 4.6 0 0 1 0 35.4 V 4.6 A 4.6 4.6 0 0 1 4.6 0 H 20' },
  { metric: 'memory', label: 'memory', path: 'M 20 40 H 35.4 A 4.6 4.6 0 0 0 40 35.4 V 4.6 A 4.6 4.6 0 0 0 35.4 0 H 20' }
] as const;

// supply the numeric equivalent of the decorative border gauges
export const resourceGaugeDescription = (averages: ResourceAverages): string => sides.flatMap(({ metric, label }) => {
  const value = averages[metric];
  return value === null ? [] : [`5-minute ${label} average: ${resourcePercent(value)}`];
}).join(' · ');

// run two mirrored perimeter scales from bottom center to top center
export function ServerResourceGauges({ averages }: { averages: ResourceAverages }) {
  // no reading is different from a measured zero
  if (averages.cpu === null && averages.memory === null) return null;
  return <svg className="server-selector-resource-gauges" viewBox="0 0 40 40" aria-hidden="true" focusable="false">
    {/* normalize each half to the same zero-to-one-hundred scale */}
    {sides.map(({ metric, path }) => {
      const value = averages[metric];
      // omit that side until it has a real average
      if (value === null) return null;
      return <g key={metric}>
        <path className="server-selector-gauge-track" d={path} pathLength={100} />
        {value > 0 && <path className={`server-selector-gauge-fill${resourceSeverityClass(value)}`} data-resource={metric} d={path} pathLength={100} strokeDasharray={`${value} 100`} />}
      </g>;
    })}
    {/* separate the mirrored scales at zero and full usage */}
    <path className="server-selector-gauge-endpoints" d="M 20 -2 V 2 M 20 38 V 42" />
  </svg>;
}
