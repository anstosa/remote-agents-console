#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { access, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { cpus, freemem, totalmem } from 'node:os';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { linuxDiskUsage } from './resource-monitor-disks.mjs';

const execute = promisify(execFile);
const sampleDelayMs = 250;
const powershellTimeoutMs = 8_000;
const recoveryPowershellTimeoutMs = 3_000;
const windowsFreshnessMs = 3_000;
const maxPowershellBufferBytes = 512_000;
const liveLeaseTimeoutMs = 5_000;
const liveLeaseStartupMs = 10_000;
const streamIntervalMs = 1_000;

// keep percentages inside their public range
const percent = value => Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value * 10) / 10)) : null;

// total CPU counters across every logical processor
const cpuCounters = () => cpus().reduce((sum, cpu) => {
  // collect every named CPU time
  for (const value of Object.values(cpu.times)) sum.total += value;
  sum.idle += cpu.times.idle;
  return sum;
}, { idle: 0, total: 0 });

// sample CPU utilization over one bounded interval
const linuxCpuPercent = async () => {
  const first = cpuCounters();
  await new Promise(resolve => setTimeout(resolve, sampleDelayMs));
  const second = cpuCounters();
  const elapsed = second.total - first.total;
  // reject hosts that expose no changing CPU counters
  if (elapsed <= 0) return null;
  return percent((1 - (second.idle - first.idle) / elapsed) * 100);
};

// prefer Linux's available-memory estimate over raw free pages
const linuxMemory = async () => {
  const text = await readFile('/proc/meminfo', 'utf8').catch(() => undefined);
  // fall back to Node's portable counters off procfs
  if (text === undefined) return { usedBytes: totalmem() - freemem(), totalBytes: totalmem() };
  const values = new Map();
  // retain the small numeric meminfo subset
  for (const line of text.split('\n')) {
    const match = /^(MemTotal|MemAvailable):\s+(\d+)\s+kB$/u.exec(line);
    // skip unrelated procfs fields
    if (match === null) continue;
    values.set(match[1], Number(match[2]) * 1024);
  }
  const total = values.get('MemTotal');
  const available = values.get('MemAvailable');
  // reject an incomplete procfs record
  if (total === undefined || available === undefined) return { usedBytes: totalmem() - freemem(), totalBytes: totalmem() };
  return { usedBytes: Math.max(0, total - available), totalBytes: total };
};

// sample Linux CPU and memory without inspecting disks
const linuxMetricsSnapshot = async () => {
  const [cpu, memoryResult] = await Promise.allSettled([linuxCpuPercent(), linuxMemory()]);
  return {
    cpuPercent: cpu.status === 'fulfilled' ? cpu.value : null,
    memory: memoryResult.status === 'fulfilled' ? memoryResult.value : null,
    disks: []
  };
};

// inspect Linux disks without sampling CPU or memory
const linuxDiskSnapshot = async () => {
  const [disks] = await Promise.allSettled([readFile('/proc/self/mountinfo', 'utf8').then(linuxDiskUsage)]);
  return {
    cpuPercent: null,
    memory: null,
    disks: disks.status === 'fulfilled' ? disks.value : [],
    ...(disks.status === 'fulfilled' ? {} : { diskError: 'Disk usage is unavailable.' })
  };
};

const powershellHelpers = String.raw`
$ErrorActionPreference = 'Stop'
# normalize every attached fixed or removable volume
function Get-RacVolumes {
  @(Get-CimInstance -ClassName Win32_Volume | Where-Object {
    # retain mounted formatted user volumes with readable capacity
    ($_.DriveType -eq 2 -or $_.DriveType -eq 3) -and
      $null -ne $_.DriveLetter -and
      -not [string]::IsNullOrWhiteSpace([string]$_.FileSystem) -and
      $null -ne $_.Capacity -and
      $null -ne $_.FreeSpace -and
      [double]$_.Capacity -gt 0
  } | ForEach-Object {
    $total = [double]$_.Capacity
    # calculate formatted volume usage
    $used = [double]$_.Capacity - [double]$_.FreeSpace
    $mount = [string]$_.DriveLetter + '\'
    [pscustomobject]@{ mount = $mount; usedBytes = $used; totalBytes = $total }
  })
}
# sample Windows CPU and memory without probing disks
function Get-RacMetrics {
  $os = Get-CimInstance -ClassName Win32_OperatingSystem
  $cpu = $null
  # read cooked total CPU usage
  try {
    $processor = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'"
    # preserve unavailable counters
    if ($null -ne $processor.PercentProcessorTime) { $cpu = [double]$processor.PercentProcessorTime }
  } catch {}
  $memory = $null
  # preserve unavailable memory counters
  if ($null -ne $os.TotalVisibleMemorySize -and $null -ne $os.FreePhysicalMemory) {
    $memory = [pscustomobject]@{ usedBytes = ([double]$os.TotalVisibleMemorySize - [double]$os.FreePhysicalMemory) * 1024; totalBytes = [double]$os.TotalVisibleMemorySize * 1024 }
  }
  [pscustomobject]@{ cpuPercent = $cpu; memory = $memory; disks = @() }
}
`;

const powershellDiskScript = String.raw`${powershellHelpers}
$disks = @()
$diskError = $null
# retain the Windows boundary when disk inspection fails
try { $disks = @(Get-RacVolumes) } catch { $diskError = 'Disk usage is unavailable.' }
$result = [ordered]@{ cpuPercent = $null; memory = $null; disks = $disks }
# publish a disk-only failure independently
if (-not [string]::IsNullOrEmpty($diskError)) { $result['diskError'] = $diskError }
[pscustomobject]$result | ConvertTo-Json -Compress -Depth 5
`;

const powershellMetricsScript = String.raw`${powershellHelpers}
Get-RacMetrics | ConvertTo-Json -Compress -Depth 5
`;

const powershellRecoveryScript = String.raw`${powershellHelpers}
$metrics = $null
$disks = @()
$diskError = $null
# keep partial host data when one Windows counter family is unavailable
try { $metrics = Get-RacMetrics } catch {}
try { $disks = @(Get-RacVolumes) } catch { $diskError = 'Disk usage is unavailable.' }
$result = [ordered]@{
  cpuPercent = if ($null -eq $metrics) { $null } else { $metrics.cpuPercent }
  memory = if ($null -eq $metrics) { $null } else { $metrics.memory }
  disks = $disks
}
# publish volume failure independently from CPU and memory
if (-not [string]::IsNullOrEmpty($diskError)) { $result['diskError'] = $diskError }
[pscustomobject]$result | ConvertTo-Json -Compress -Depth 5
`;

const powershellStreamScript = String.raw`${powershellHelpers}
while ($true) {
  # self-stop Windows inspection when its parent lease ends
  if ($null -ne $RacLeasePath) {
    if (!(Test-Path -LiteralPath $RacLeasePath)) { break }
    $leaseAgeMs = [Math]::Abs(((Get-Date) - (Get-Item -LiteralPath $RacLeasePath).LastWriteTime).TotalMilliseconds)
    if ($leaseAgeMs -gt 5000) { break }
  }
  $sampleStarted = [System.Diagnostics.Stopwatch]::GetTimestamp()
  try {
    [Console]::Out.WriteLine((Get-RacMetrics | ConvertTo-Json -Compress -Depth 5))
    [Console]::Out.Flush()
  } catch {}
  $elapsedMs = ([System.Diagnostics.Stopwatch]::GetTimestamp() - $sampleStarted) * 1000 / [System.Diagnostics.Stopwatch]::Frequency
  $remainingMs = 1000 - [int]$elapsedMs
  # hold start-to-start cadence near one second
  if ($remainingMs -gt 0) { Start-Sleep -Milliseconds $remainingMs }
}
`;

// resolve Windows PowerShell from interop PATH before its conventional WSL fallback
const powershellExecutable = async () => {
  // native Windows resolves its system executable directly
  if (process.platform === 'win32') return 'powershell.exe';
  // prefer the active WSL interop PATH
  for (const directory of (process.env.PATH ?? '').split(':')) {
    const candidate = `${directory}/powershell.exe`;
    // accept the first executable path the host exposed
    if (await access(candidate).then(() => true).catch(() => false)) return candidate;
  }
  return '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
};

// keep one PowerShell process alive for live Windows samples
const startWindowsStream = async (stopSignal, liveLease) => {
  let windowsLease = liveLease;
  // translate a WSL path for the Windows-side lease check
  if (liveLease !== undefined && process.platform !== 'win32') {
    windowsLease = await execute('/usr/bin/wslpath', ['-w', liveLease], { encoding: 'utf8', timeout: 1_000 }).then(result => result.stdout.trim()).catch(() => undefined);
  }
  const leaseValue = windowsLease === undefined ? '$null' : `'${windowsLease.replaceAll("'", "''")}'`;
  const encoded = Buffer.from(`$RacLeasePath = ${leaseValue}\n${powershellStreamScript}`, 'utf16le').toString('base64');
  const child = spawn(await powershellExecutable(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  child.stdout.setEncoding('utf8');
  let buffer = '';
  let latest;
  let latestAt = 0;
  let ended = false;
  let readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  // retain the newest complete PowerShell record
  child.stdout.on('data', chunk => {
    buffer += chunk;
    // stop malformed output before its partial line can grow without bound
    if (Buffer.byteLength(buffer) > maxPowershellBufferBytes) {
      buffer = '';
      child.kill('SIGTERM');
      return;
    }
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? '';
    // parse each complete resource record
    for (const line of lines) {
      try {
        latest = JSON.parse(line.trim());
        latestAt = performance.now();
        readyResolve?.();
        readyResolve = undefined;
      } catch {}
    }
  });
  const end = () => {
    ended = true;
    readyResolve?.();
    readyResolve = undefined;
  };
  child.once('error', end);
  child.once('exit', end);
  // stop the exact interop child with its owning collector
  stopSignal.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
  // close a child created during a cancellation race
  if (stopSignal.aborted) child.kill('SIGKILL');
  return { child, ready, latest: () => ended || performance.now() - latestAt > windowsFreshnessMs ? undefined : latest };
};

// inspect the Windows host through the documented WSL interop boundary
const windowsSnapshot = async mode => {
  const script = mode === 'disks' ? powershellDiskScript : mode === 'recovery-host' ? powershellRecoveryScript : powershellMetricsScript;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded];
  const options = { encoding: 'utf8', timeout: mode === 'recovery-host' ? recoveryPowershellTimeoutMs : powershellTimeoutMs, maxBuffer: maxPowershellBufferBytes, windowsHide: true };
  let command = 'powershell.exe';
  let stdout;
  try { ({ stdout } = await execute(command, args, options)); }
  catch (error) {
    // use the conventional WSL location only when inherited interop PATH lookup is absent
    if (process.platform === 'win32' || error?.code !== 'ENOENT') throw error;
    command = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
    ({ stdout } = await execute(command, args, options));
  }
  return JSON.parse(stdout.trim());
};

// identify Microsoft's Linux kernel without depending on mutable environment variables
const isWsl = async () => {
  const release = await readFile('/proc/sys/kernel/osrelease', 'utf8').catch(() => '');
  return /microsoft/iu.test(release);
};

// collect disk capacities only when the disk endpoint requests them
const collectDisks = async () => {
  const sampledAt = new Date().toISOString();
  // native Windows has only the Windows host boundary
  if (process.platform === 'win32') {
    try { return { sampledAt, host: await windowsSnapshot('disks') }; }
    catch { return { sampledAt, host: null, errors: ['Windows disk monitoring is unavailable.'] }; }
  }
  const wsl = await isWsl();
  // ordinary Linux is the host boundary
  if (!wsl) return { sampledAt, host: await linuxDiskSnapshot() };
  let linux;
  let host = null;
  const errors = [];
  try { linux = await linuxDiskSnapshot(); }
  catch { errors.push('WSL disk monitoring is unavailable.'); }
  try { host = await windowsSnapshot('disks'); }
  catch { errors.push('Windows disk monitoring is unavailable.'); }
  return { sampledAt, host, ...(linux === undefined ? {} : { wsl: linux }), ...(errors.length === 0 ? {} : { errors }) };
};

// collect CPU and memory only when the metrics endpoint requests them
const collectMetrics = async () => {
  const sampledAt = new Date().toISOString();
  // native Windows has only the Windows host boundary
  if (process.platform === 'win32') {
    try { return { sampledAt, host: await windowsSnapshot('metrics') }; }
    catch { return { sampledAt, host: null, errors: ['Windows resource monitoring is unavailable.'] }; }
  }
  const wsl = await isWsl();
  // ordinary Linux is the host boundary
  if (!wsl) {
    try { return { sampledAt, host: await linuxMetricsSnapshot() }; }
    catch { return { sampledAt, host: null, errors: ['Linux resource monitoring is unavailable.'] }; }
  }
  let linux;
  let host = null;
  const errors = [];
  try { linux = await linuxMetricsSnapshot(); }
  catch { errors.push('WSL resource monitoring is unavailable.'); }
  try { host = await windowsSnapshot('metrics'); }
  catch { errors.push('Windows resource monitoring is unavailable.'); }
  return { sampledAt, host, ...(linux === undefined ? {} : { wsl: linux }), ...(errors.length === 0 ? {} : { errors }) };
};

const outputIndex = process.argv.indexOf('--output');
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
const leaseIndex = process.argv.indexOf('--lease');
const lease = leaseIndex >= 0 ? process.argv[leaseIndex + 1] : undefined;

// accept only a recently refreshed parent-owned lease
const liveLeaseFresh = async maximumAge => {
  // standalone streams do not require a parent lease
  if (lease === undefined) return true;
  const status = await stat(lease).catch(() => undefined);
  // stop when the exact lease disappears or grows stale
  if (status === undefined) return false;
  return Math.abs(Date.now() - status.mtimeMs) <= maximumAge;
};

// wait until one cadence boundary or cancellation
const wait = (duration, signal) => new Promise(resolve => {
  // finish immediately after cancellation
  if (signal.aborted) { resolve(); return; }
  const timer = setTimeout(done, duration);
  // clear the exact pending delay
  function done() {
    clearTimeout(timer);
    signal.removeEventListener('abort', done);
    resolve();
  }
  signal.addEventListener('abort', done, { once: true });
});

// publish one bounded atomic file record or stdout line
const publish = async value => {
  const serialized = `${JSON.stringify(value)}\n`;
  // write directly only when no host-bridge file was requested
  if (output === undefined) { process.stdout.write(serialized); return; }
  await writeFile(`${output}.next`, serialized, { mode: 0o600 });
  await rename(`${output}.next`, output);
};

// collect one-second CPU and memory updates only for the life of this process
const stream = async signal => {
  // reject an absent or stale lease before starting Windows inspection
  if (!await liveLeaseFresh(liveLeaseStartupMs)) return true;
  const wsl = process.platform !== 'win32' && await isWsl();
  const windows = process.platform === 'win32' || wsl ? await startWindowsStream(signal, lease) : undefined;
  let leaseExpired = false;
  try {
    // bound initial Windows discovery before publishing partial availability
    if (windows !== undefined) {
      const startupWait = new AbortController();
      const cancelStartup = () => startupWait.abort();
      signal.addEventListener('abort', cancelStartup, { once: true });
      // cancel the losing timeout so it cannot retain an expired collector
      try { await Promise.race([windows.ready, wait(powershellTimeoutMs, startupWait.signal)]); }
      finally {
        startupWait.abort();
        signal.removeEventListener('abort', cancelStartup);
      }
    }
    let sequence = 0;
    // sample until the exact client-owned collector is cancelled
    while (!signal.aborted) {
      // self-stop after the parent heartbeat ends
      if (!await liveLeaseFresh(liveLeaseTimeoutMs)) { leaseExpired = true; break; }
      const tickStarted = performance.now();
      let linux;
      // retain ordinary Linux or WSL as its own boundary
      if (process.platform !== 'win32') {
        linux = await linuxMetricsSnapshot();
      }
      // never publish work completed after lease expiry
      if (!await liveLeaseFresh(liveLeaseTimeoutMs)) { leaseExpired = true; break; }
      const windowsHost = windows?.latest();
      const errors = [];
      // disclose missing or stale Windows data without hiding WSL
      if (windows !== undefined && windowsHost === undefined) errors.push('Windows resource monitoring is unavailable.');
      const snapshot = {
        sampledAt: new Date().toISOString(),
        host: wsl ? windowsHost ?? null : process.platform === 'win32' ? windowsHost ?? null : linux ?? null,
        ...(wsl && linux !== undefined ? { wsl: linux } : {}),
        ...(errors.length === 0 ? {} : { errors })
      };
      sequence += 1;
      await publish(output === undefined ? snapshot : { sequence, snapshot });
      const remaining = Math.max(0, streamIntervalMs - (performance.now() - tickStarted));
      await wait(remaining, signal);
    }
  } finally {
    // never orphan Windows inspection after any Linux or output failure
    windows?.child.kill('SIGKILL');
  }
  return leaseExpired;
};

// bind process lifetime to its exact native or tmux owner
const stop = new AbortController();
const stopCollector = () => stop.abort();
process.once('SIGHUP', stopCollector);
process.once('SIGINT', stopCollector);
process.once('SIGTERM', stopCollector);

// require one explicit fixed collector mode
if (process.argv.includes('--stream')) {
  const leaseExpired = await stream(stop.signal);
  // remove only this collector's exact bounded files after parent loss
  if (leaseExpired && output !== undefined && lease !== undefined && dirname(output) === dirname(lease)) {
    await Promise.all([rm(output, { force: true }), rm(`${output}.next`, { force: true }), rm(lease, { force: true })]);
    await rmdir(dirname(output)).catch(() => undefined);
  }
} else if (process.argv.includes('--metrics')) await publish(await collectMetrics());
else if (process.argv.includes('--disks')) await publish(await collectDisks());
else if (process.argv.includes('--recovery-host')) await publish(await windowsSnapshot('recovery-host'));
else {
  // do not inspect the host on an unqualified invocation
  process.stderr.write('Specify --metrics, --disks, --recovery-host, or --stream.\n');
  process.exitCode = 2;
}
