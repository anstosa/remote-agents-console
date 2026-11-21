import type { ReactNode } from 'react';
import type { SettingsSource } from './contracts.js';

type PageHeaderCopy = {
  eyebrow: 'Settings' | 'Deployment settings';
  description: string;
};

// keep page headings neutral and describe each page's purpose
const pageHeaders: Readonly<Record<string, PageHeaderCopy>> = {
  browser: { eyebrow: 'Settings', description: 'Manage this browser’s name and identity.' },
  voice: { eyebrow: 'Settings', description: 'Configure the voice assistant and reduce its access below the MCP capability ceiling.' },
  'google-calendar': { eyebrow: 'Settings', description: 'Capture supported agent work in a dedicated Google Calendar.' },
  keyboard: { eyebrow: 'Settings', description: 'Configure keyboard shortcuts.' },
  interface: { eyebrow: 'Settings', description: 'Customize appearance, flyout markers, and buttons.' },
  notes: { eyebrow: 'Settings', description: 'Configure what happens to notes after sending or queuing.' },
  files: { eyebrow: 'Settings', description: 'Choose what happens when you click a file.' },
  app: { eyebrow: 'Settings', description: 'Configure network access, integrations, and remote servers.' },
  agents: { eyebrow: 'Settings', description: 'Choose the default adapter and configure programs, credentials, and agent behavior.' },
  mcp: { eyebrow: 'Settings', description: 'Set the maximum capabilities available to MCP, Conductor, and Voice.' },
  conductor: { eyebrow: 'Settings', description: 'Configure Conductor and reduce its access below the MCP capability ceiling.' },
  projects: { eyebrow: 'Settings', description: 'Configure repositories, worktrees, and project-specific commands.' },
  reviews: { eyebrow: 'Settings', description: 'Configure Review tours and optional AI code-review presets.' },
  tmux: { eyebrow: 'Settings', description: 'Configure terminal discovery, polling, and the host tmux wrapper.' },
  storage: { eyebrow: 'Settings', description: 'Configure data files, scratch directories, and workspace storage.' },
  env: { eyebrow: 'Deployment settings', description: 'Configure runtime environment variables, executable paths, and protected credentials.' },
  installation: { eyebrow: 'Deployment settings', description: 'Configure source locations and review host-managed installation details.' },
  'compose-override': { eyebrow: 'Deployment settings', description: 'Customize services, ports, environment variables, and volume mounts layered over the base compose.yaml.' },
  cloudflare: { eyebrow: 'Deployment settings', description: 'Configure secure remote access through a Cloudflare Tunnel.' }
};

// keep configuration metadata subordinate to the page heading
export function SettingsPageHeader({ pageId, title, source, actions }: { pageId: string; title: string; source?: SettingsSource; actions?: ReactNode }) {
  const copy = pageHeaders[pageId] ?? { eyebrow: 'Settings', description: 'Review and edit this configuration source.' };
  const sourceClass = pageId === 'app' ? ' settings-application-header' : pageId === 'compose-override' ? ' settings-docker-header' : '';
  return <header className={`settings-source-header${sourceClass}${actions == null ? '' : ' settings-source-header-with-actions'}`}>
    <div className="settings-source-heading"><span className="settings-source-kicker">{copy.eyebrow}</span><h2>{title}</h2></div>
    {actions}
    <p className="settings-preference-description">{copy.description}</p>
    {source !== undefined && <p className="settings-source-metadata"><span>{source.format} · {source.exists ? 'present' : 'not created'}</span>{source.path && <code title={source.path}>{source.path}</code>}</p>}
  </header>;
}
