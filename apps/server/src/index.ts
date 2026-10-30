import { existsSync } from 'node:fs';
import { acquireConfig, migrationErrorLines } from './migrations/boot.js';
import { retireBookmarks } from './conversations/retire-bookmarks.js';
import { formatSavedPromptsToNotes, migrateSavedPromptsToNotes } from './migrations/saved-prompts-to-notes.js';
import { buildApp } from './app.js';
import { ControlService } from './auth/control.js';
import { WorktreeNoteService } from './notes/service.js';
import { DiscoveryService } from './discovery/service.js';
import { TmuxCommandRegistry } from './tmux/command-registry.js';
import { TmuxAdapter } from './tmux/adapter.js';
import { PushService } from './push-service.js';
import { AgentNotificationCoordinator } from './notifications.js';
import { dashboardFingerprint, DashboardUpdates, type DashboardPayload } from './dashboard/updates.js';
import { CleanupService } from './cleanup/service.js';
import { CleanupMonitor } from './cleanup/monitor.js';
import { WorktreeLaunchStore } from './worktrees/store.js';
import { WorktreeManagementService } from './worktrees/management.js';
import { PullRequestSwitchService } from './pull-requests/switch-service.js';
import { GithubService } from './github/service.js';
import type { Project } from './domain/models.js';
import { attestBoot, bootInstallation } from './settings/boot.js';
import type { ConfigSourceMigration } from './migrations/runner.js';

// use the fixed installer identity for native environment sources
const settingsInstallation = await bootInstallation().catch(() => { process.stderr.write('Settings host capability unavailable; configuration remains read-only.\n'); return undefined; });
const envFile = settingsInstallation?.sources.env?.serverPath ?? new URL('../../../.env', import.meta.url);
// retain inherited environment precedence during bootstrap
if (existsSync(envFile)) process.loadEnvFile(envFile);
let applicationContent = '';
let applicationMigration: ConfigSourceMigration | undefined;

// migrate a legacy config in place, then validate; surface every content or writability
// problem as `Configuration invalid:` lines and exit, never an unhandled-rejection trace
// preserve the exact consumed source and any completed config-only migration
const config = await acquireConfig(process.env, undefined, (content, migration) => { applicationContent = content; applicationMigration = migration; }).catch((error: unknown) => {
  for (const message of migrationErrorLines(error)) process.stderr.write(`Configuration invalid: ${message}\n`);
  process.exit(1);
});
// retire any pre-existing Bookmark store once: log each saved bookmark and set the file aside
// (Conversations replace bookmarks; ADR 0007). A missing file is a no-op, so this fires once.
await retireBookmarks();
// dashboard commands share a quiet connection independently of browser viewers
const tmux = new TmuxAdapter(new TmuxCommandRegistry()); const worktreeStore = new WorktreeLaunchStore(); const github: GithubService = new GithubService({ projects: (): readonly Project[] => discovery.projectsNow(), worktrees: () => discovery.worktreesNow() }); const discovery = new DiscoveryService(undefined, tmux, undefined, github, config.adapters, config.projects, worktreeStore, undefined, config.scratchDirectory); const push = new PushService(); const prSwitch = new PullRequestSwitchService(config, discovery, github); const worktreeManagement = new WorktreeManagementService(() => discovery.projectsNow(), undefined, github, prSwitch); const cleanup = new CleanupService(discovery, undefined, tmux, undefined, worktreeManagement);
// generate or import the durable push identity without blocking console recovery
await push.initialize().catch(() => { process.stderr.write('[push] VAPID storage unavailable; push alerts disabled until storage is writable and valid.\n'); });
const dashboardPollMs = config.pollIntervalMs;
const notifications = new AgentNotificationCoordinator(notification => push.notify(notification), Math.max(2_000, dashboardPollMs * 2));
const dashboardUpdates = new DashboardUpdates<DashboardPayload>(dashboardFingerprint);
// carry any legacy saved prompts into Notes before the app builds, then hand buildApp the same
// notes service; the source file is moved aside so a second boot is a no-op. This must run AFTER
// acquireConfig (above), which re-keys a legacy saved-prompts file onto `<projectId>:<realpath>`
// wire ids — otherwise projectIdOf would read a legacy key and skip every prompt as unconfigured.
const notes = new WorktreeNoteService();
const savedPromptsLines = formatSavedPromptsToNotes(await migrateSavedPromptsToNotes({ projectIds: config.projects.map(project => project.id), notes }));
if (savedPromptsLines.length > 0) { process.stderr.write('Saved prompts migration:\n'); for (const line of savedPromptsLines) process.stderr.write(`  ${line}\n`); }
// preserve the last controller while every new process starts disconnected
const control = await ControlService.persisted();
const app = await buildApp(config, { control, tmux, discovery, push, notifications, cleanup, dashboardUpdates, worktreeStore, worktreeManagement, prSwitch, notes, github });
// publish evidence before serving health without a host queue dependency
await attestBoot(settingsInstallation, config, applicationContent, undefined, applicationMigration);
// honor the configured cadence while overlapping refreshes coalesce
const dashboardTimer = setInterval(() => void dashboardUpdates.refresh().catch(() => {}), dashboardPollMs);
const cleanupMonitor = new CleanupMonitor(cleanup, dashboardUpdates, push);
app.addHook('onClose', async () => { clearInterval(dashboardTimer); cleanupMonitor.stop(); notifications.stop(); });
void dashboardUpdates.refresh().catch(() => {});
cleanupMonitor.start();
// reconnect to the structured Agents' holders, which replay what this console has not read, before
// the scheduler judges a Run by its Agent (for at most 10 s: a holder that never answers holds up nothing)
const reattached = app.structuredAgents.reattach().catch(error => { console.error('[structured] reattach failed:', error); });
await Promise.race([reattached, new Promise(resolve => setTimeout(resolve, 10_000).unref())]);
// fire enabled Schedules unattended, beside the other periodic jobs; buildApp's onClose stops it
app.scheduler.start();
await app.listen(config.listen);
// once the reattach settles, bring up the Conductor (or turn one off that is no longer configured)
void reattached.then(() => app.conductor.start()).catch(error => { console.error('[conductor] could not start:', error); });
// and re-arm the Watches' commands (a reboot ended their windows), polling GitHub from now on
void reattached.then(() => app.watches.start()).catch(error => { console.error('[watches] could not start:', error); });
