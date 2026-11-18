import { statfs } from 'node:fs/promises';

const pseudoFilesystems = new Set(['autofs', 'bpf', 'cgroup', 'cgroup2', 'configfs', 'debugfs', 'devpts', 'devtmpfs', 'efivarfs', 'fusectl', 'hugetlbfs', 'mqueue', 'nsfs', 'overlay', 'proc', 'pstore', 'ramfs', 'securityfs', 'squashfs', 'sysfs', 'tmpfs', 'tracefs']);

// decode the octal escapes used by procfs mount records
const mountValue = value => value.replace(/\\(040|011|012|134)/gu, (_match, code) => String.fromCharCode(Number.parseInt(code, 8)));

// choose one visible mount for each physical filesystem
const userDiskMounts = text => {
  const mounts = new Map();
  // collapse bind mounts by device without exposing device identities
  for (const line of text.split('\n')) {
    const fields = line.split(' ');
    const separator = fields.indexOf('-');
    // reject incomplete mountinfo lines
    if (separator < 6) continue;
    const filesystem = fields[separator + 1];
    const source = mountValue(fields[separator + 2] ?? '');
    // exclude memory, kernel and container filesystems
    if (filesystem === undefined || pseudoFilesystems.has(filesystem)) continue;
    // exclude loop-backed images even when they use a normal filesystem
    if (source.startsWith('/dev/loop')) continue;
    // accept block-backed filesystems and ZFS datasets
    if (!source.startsWith('/dev/') && filesystem !== 'zfs') continue;
    const id = fields[2];
    const mount = mountValue(fields[4] ?? '');
    // suppress auxiliary boot and recovery mounts but keep the root filesystem
    if (/^\/(?:boot|efi|recovery)(?:\/|$)/iu.test(mount)) continue;
    // retain the shortest representative mount for one filesystem
    if (id === undefined || !mount.startsWith('/') || (mounts.get(id)?.length ?? Infinity) <= mount.length) continue;
    mounts.set(id, mount);
  }
  // collapse overmounted paths before inspecting their visible filesystem
  return new Set(mounts.values());
};

// read capacities only for user-visible filesystems
export const linuxDiskUsage = async (mountInfo, statFilesystem = statfs) => {
  const disks = [];
  // read only selected mount paths
  for (const mount of userDiskMounts(mountInfo)) {
    try {
      const stats = await statFilesystem(mount, { bigint: true });
      const totalBytes = Number(stats.blocks * stats.bsize);
      const freeBytes = Number(stats.bfree * stats.bsize);
      // hide unavailable or zero-capacity filesystems
      if (!Number.isFinite(totalBytes) || !Number.isFinite(freeBytes) || totalBytes <= 0) continue;
      disks.push({ mount, usedBytes: Math.max(0, totalBytes - freeBytes), totalBytes });
    } catch {}
  }
  return disks.sort((left, right) => left.mount.localeCompare(right.mount));
};
