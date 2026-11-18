import type { CSSProperties } from 'react';
import type { ResourceUsage } from '../../server/src/server-admin/resource-contracts.js';
import type { DiskUsage, MetricUsage } from './server-resource-cache.js';
import { resourceBytes, resourcePercent, resourceSeverityClass, usagePercent } from './server-resource-values.js';
import { Skeleton } from './skeleton.js';
import './server-resources.css';

// retain exact capacities underneath their percentage bar
const capacity = (used: number | null, total: number | null): string | undefined => used === null || total === null || total <= 0
  ? undefined
  : `${resourceBytes(used)} / ${resourceBytes(total)}`;

// share one status-colored bar across all available metrics
function ResourceBar({ label, value, reading }: { label: string; value: number; reading: string }) {
  const style = { '--resource-fill': `${value}%` } as CSSProperties;
  return <div className={`server-resource-bar${resourceSeverityClass(value)}`} role="meter" aria-label={`${label} usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-valuetext={reading} style={style}><span className="server-resource-bar-fill" /></div>;
}

// put total memory in the label without repeating a used/total row
function ResourceMetric({ label, value, total }: { label: string; value: number | null; total?: string }) {
  const shown = value === null ? 'Unavailable' : resourcePercent(value);
  return <div className="server-resource-metric">
    <div className="server-resource-metric-heading"><span>{label}{total !== undefined && <small> ({total})</small>}</span><strong>{shown}</strong></div>
    {value === null ? <div className="server-resource-bar unavailable" aria-hidden="true" /> : <ResourceBar label={label} value={value} reading={shown} />}
  </div>;
}

// render one namespace without conflating windows and wsl resources
function ResourceGroup({ usage, diskUsage, name, showTitle, loading, diskLoading }: { usage?: ResourceUsage | null; diskUsage?: ResourceUsage | null; name: 'Host' | 'WSL'; showTitle?: boolean; loading: boolean; diskLoading: boolean }) {
  return <div className="server-resource-group" role="group" aria-label={`${name} resources`}>
    {showTitle && <strong className="server-resource-group-title">Host</strong>}
    {loading && <ResourceSkeleton />}
    {usage === null && <span className="server-resource-note">Host resources unavailable.</span>}
    {usage != null && <>
      <ResourceMetric label="CPU" value={usage.cpuPercent} />
      <ResourceMetric label="Memory" value={usagePercent(usage.memory?.usedBytes ?? null, usage.memory?.totalBytes ?? null)} total={usage.memory !== null && usage.memory.totalBytes > 0 ? resourceBytes(usage.memory.totalBytes) : undefined} />
    </>}
    {diskLoading && <div className="server-resource-metric" aria-hidden="true"><div className="server-resource-metric-heading"><Skeleton className="server-resource-skeleton-value" /><Skeleton className="server-resource-skeleton-caption" /></div><Skeleton className="server-resource-skeleton-bar" /></div>}
    {/* show only usable mounts and their capacities, without volume labels */}
    {diskUsage?.disks.map(disk => {
      const detail = capacity(disk.usedBytes, disk.totalBytes);
      const value = usagePercent(disk.usedBytes, disk.totalBytes);
      // omit unavailable or unmounted media
      if (detail === undefined || value === null || disk.mount === '') return null;
      return <div className="server-resource-metric server-resource-disk" key={disk.mount}>
        <div className="server-resource-metric-heading"><span className="server-resource-mount" title={disk.mount}>{disk.mount}</span><strong className="server-resource-capacity">{detail}</strong></div>
        <ResourceBar label={disk.mount} value={value} reading={detail} />
      </div>;
    })}
  </div>;
}

// reserve chart geometry only before the first metric sample settles
function ResourceSkeleton() {
  return <div className="server-resource-skeleton" aria-hidden="true">
    {/* match the metric headings and tracks */}
    {['CPU', 'Memory'].map(label => <div className="server-resource-metric" key={label}>
      <div className="server-resource-metric-heading"><span>{label}</span><Skeleton className="server-resource-skeleton-value" /></div>
      <Skeleton className="server-resource-skeleton-bar" />
    </div>)}
  </div>;
}

// show cached values immediately and replace them as live samples arrive
export function ServerResources({ metrics, disks }: { metrics?: MetricUsage; disks?: DiskUsage }) {
  const snapshot = metrics?.snapshot;
  const loading = metrics === undefined;
  const hasWsl = snapshot?.wsl !== undefined || (disks?.wsl !== undefined && (snapshot?.host == null || metrics?.refreshFailed));
  const diskLoading = disks === undefined;
  const busy = loading || diskLoading;
  const hasDiskReadings = (hasWsl && (disks?.wsl?.disks.length ?? 0) > 0) || (disks?.host?.disks.length ?? 0) > 0;
  return <section className="server-resources" aria-label="Server resource monitoring" aria-busy={busy}>
    {busy && <span className="sr-only" role="status">Loading server resources</span>}
    {metrics?.refreshFailed && <span className="server-resource-note" role="status">{snapshot?.host != null || snapshot?.wsl !== undefined ? 'CPU or memory refresh failed. Showing last available readings.' : 'CPU and memory usage unavailable.'}</span>}
    {/* keep wsl above its windows host, even before the live sample arrives */}
    {hasWsl && <ResourceGroup name="WSL" usage={snapshot?.wsl} diskUsage={disks?.wsl} loading={loading} diskLoading={diskLoading} />}
    {(loading || snapshot !== undefined || disks?.host != null) && <ResourceGroup name="Host" showTitle={hasWsl} usage={snapshot?.host} diskUsage={disks?.host} loading={loading} diskLoading={diskLoading} />}
    {disks?.refreshFailed && <span className="server-resource-note" role="status">{hasDiskReadings ? 'Disk refresh failed. Showing last available readings.' : 'Disk usage unavailable.'}</span>}
  </section>;
}
