import type { ReactNode } from 'react';
import type { SettingsSource } from './contracts.js';

type PageHeaderCopy = {
  eyebrow: 'Browser settings' | 'Server settings' | 'Deployment settings';
  description: string;
};

// keep every page's scope and purpose in one presentation contract
const pageHeaders: Readonly<Record<string, PageHeaderCopy>> = {
  browser: { eyebrow: 'Browser settings', description: 'Customize this browser’s identity, appearance, terminal, and workspace behavior.' },
  voice: { eyebrow: 'Server settings', description: 'Configure the voice assistant, its context, tools, and credentials.' },
  keyboard: { eyebrow: 'Server settings', description: 'Configure server-wide keyboard shortcuts stored with the application.' },
  app: { eyebrow: 'Server settings', description: 'Configure network access, integrations, and remote servers.' },
  agents: { eyebrow: 'Server settings', description: 'Configure agent programs, launch commands, and credentials.' },
  projects: { eyebrow: 'Server settings', description: 'Configure repositories, worktrees, and project-specific commands.' },
  reviews: { eyebrow: 'Server settings', description: 'Configure Review tours and optional AI code-review presets.' },
  tmux: { eyebrow: 'Server settings', description: 'Configure terminal discovery, polling, and the host tmux wrapper.' },
  storage: { eyebrow: 'Server settings', description: 'Configure data files, scratch directories, and workspace storage.' },
  env: { eyebrow: 'Deployment settings', description: 'Configure runtime environment variables, executable paths, and protected credentials.' },
  installation: { eyebrow: 'Deployment settings', description: 'Configure source locations and review host-managed installation details.' },
  'compose-override': { eyebrow: 'Deployment settings', description: 'Customize services, ports, environment variables, and volume mounts layered over the base compose.yaml.' },
  cloudflare: { eyebrow: 'Deployment settings', description: 'Configure secure remote access through a Cloudflare Tunnel.' }
};

// render the same hierarchy without mixing source metadata into the page scope
export function SettingsPageHeader({ pageId, title, source, actions }: { pageId: string; title: string; source?: SettingsSource; actions?: ReactNode }) {
  const copy = pageHeaders[pageId] ?? { eyebrow: 'Server settings', description: 'Review and edit this configuration source.' };
  const sourceClass = pageId === 'app' ? ' settings-application-header' : pageId === 'compose-override' ? ' settings-docker-header' : '';
  return <header className={`settings-source-header${sourceClass}${actions == null ? '' : ' settings-source-header-with-actions'}`}>
    <div className="settings-source-heading"><span className="settings-source-kicker">{copy.eyebrow}</span><h2>{title}</h2></div>
    {actions}
    <p className="settings-preference-description">{copy.description}</p>
    {source !== undefined && <p className="settings-source-metadata"><span>{source.format} · {source.exists ? 'present' : 'not created'}</span>{source.path && <code title={source.path}>{source.path}</code>}</p>}
  </header>;
}
