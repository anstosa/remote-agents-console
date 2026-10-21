import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// lock the portable deployment boundary
async function repositoryFile(path: string): Promise<string> {
  return await readFile(new URL(`../../../${path}`, import.meta.url), 'utf8');
}

describe('portable deployment', () => {
  // keep worktree mounts outside tracked compose
  it('keeps the default service container-local and the tunnel opt-in', async () => {
    const compose = await repositoryFile('compose.yaml');

    expect(compose).toContain('RAC_PROJECT_PROXY_HOST: ${RAC_PROJECT_PROXY_HOST:-127.0.0.1}');
    expect(compose).toContain('RAC_SERVER_CHECKOUT: /workspace');
    // bookmarks are retired at boot; the env override stays so the one-time retirement finds the mounted file
    expect(compose).toContain('RAC_BOOKMARKS_FILE: /workspace/.data/bookmarks.json');
    expect(compose).toContain('profiles: ["tunnel"]');
    expect(compose).not.toMatch(/:\/worktrees\//);
    expect(compose).not.toContain('/host-proc');
    expect(compose).not.toContain('/home/linuxbrew');
    expect(compose).not.toContain('network_mode: "service:remote-agent-console"');
  });

  // inherit host timezone data without overriding an operator's environment file
  it('mounts host localtime read-only without forcing a timezone', async () => {
    const compose = await repositoryFile('compose.yaml');
    const dockerfile = await repositoryFile('Dockerfile');

    expect(compose).toMatch(/env_file:\s*\n\s+- \.env/);
    expect(compose).not.toMatch(/^\s+TZ:/m);
    expect(compose).toMatch(/type: bind\s+source: \/etc\/localtime\s+target: \/etc\/localtime\s+read_only: true\s+bind:\s+create_host_path: false/);
    // ICU must inspect the mounted data rather than follow the image's UTC link
    expect(dockerfile).toContain('RUN rm /etc/localtime && cp /usr/share/zoneinfo/Etc/UTC /etc/localtime');
  });

  // keep installation files outside version control
  it('ignores per-host configuration and provides a generic override example', async () => {
    const ignore = await repositoryFile('.gitignore');
    const environment = await repositoryFile('.env.example');
    const example = await repositoryFile('compose.override.example.yaml');

    expect(ignore).toContain('compose.override.yaml');
    expect(ignore).toContain('config/cloudflared.yml');
    expect(ignore).toContain('config/remote-agent-console.docker.json');
    expect(environment).toContain('RAC_GITHUB_TOKEN=');
    expect(environment).toContain('RAC_HOST_CODEX_BIN=');
    expect(example).toContain('${HOME}/.codex:/home/node/.codex:rw');
    expect(example).not.toContain('.codex/auth.json:/home/node/.codex/auth.json');
    expect(example).toContain('${HOME}/.config/gh:/home/node/.config/gh:ro');
    expect(example).not.toContain('.config/gh/hosts.yml:/home/node/.config/gh/hosts.yml');
    expect(example).toContain('${HOST_TMUX_BIN:-/usr/bin/tmux}:/host-tools/tmux:ro');
    expect(example).toContain('RAC_HOST_WORKSPACE: ${RAC_HOST_WORKSPACE:-${PWD}}');
    expect(example).toContain('RAC_HOST_CODEX_BIN: ${RAC_HOST_CODEX_BIN:-}');
    expect(example).toContain('RAC_HOST_INTERACTIVE_SHELL:');
    expect(example).toContain('/absolute/path/to/project:/worktrees/project:rw');
  });

  // prevent architecture-specific host runtime assumptions
  it('keeps the image and starter configuration portable', async () => {
    const dockerfile = await repositoryFile('Dockerfile');
    const config = JSON.parse(await repositoryFile('config/remote-agent-console.example.json')) as { publicOrigin?: string; projects?: Array<{ path?: string }> };

    expect(dockerfile).not.toContain('x86_64-linux-gnu');
    expect(dockerfile).not.toContain('/home/linuxbrew');
    expect(config.publicOrigin).toBe('http://127.0.0.1:8787');
    // the starter declares Projects, not the retired worktrees[]; its example path is a placeholder
    expect(Array.isArray(config.projects)).toBe(true);
    expect(config.projects?.every(project => typeof project.path === 'string')).toBe(true);
  });

  // require target-host source builds
  it('documents pull-then-build remote deployments', async () => {
    const guidance = await repositoryFile('AGENTS.md');

    expect(guidance).toContain('git pull --ff-only');
    expect(guidance).toContain('docker compose up -d --build');
    expect(guidance).toContain('Do not copy a working tree, built image, or generated artifact');
  });
});
