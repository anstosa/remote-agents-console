# Run with Docker Compose

The default Compose deployment runs only Remote Agent Console. It includes
Node, Codex, zsh, and tmux, and it can launch scratch agents in container-local
tmux without access to the host process tree, host worktrees, or a tunnel.
Host tmux integration and Cloudflare are independent opt-in layers.

## Start the scratch-only console

1. Create the ignored environment and Docker configuration files:

   ```bash
   cp .env.example .env
   cp config/remote-agent-console.example.json config/remote-agent-console.docker.json
   ```

2. Generate and set `RAC_PASSWORD_HASH` and `RAC_SESSION_SECRET` in `.env`.
   Wrap the Argon2 value in single quotes because its `$` characters otherwise
   trigger Compose interpolation.

   Compose inherits the Linux host's timezone through a read-only
   `/etc/localtime` mount; no `TZ` setting is needed. To deliberately use a
   different IANA timezone, set `TZ` in the same ignored `.env`.
   Queued/unsent-prompt note titles and scheduled prompts use this server-local
   timezone, including daylight-saving changes. Recreate the container after
   changing the host's timezone. Existing note titles are saved text and are
   not rewritten when the timezone changes.

3. Validate the configuration before building:

   ```bash
   pnpm config:check --compose config/remote-agent-console.docker.json
   ```

4. Build and start the console:

   ```bash
   docker compose up -d --build
   docker compose ps
   curl http://127.0.0.1:8787/healthz
   ```

Open `http://127.0.0.1:8787`. The starter configuration intentionally has no
worktrees. Use **New Agent** to launch a scratch agent inside the container.
Loopback HTTP is local-only; configure canonical HTTPS before remote access.

Upgrading a legacy `worktrees[]` config: the container mounts the repository
read-write and points `RAC_CONFIG` and `RAC_CONFIG_WRITE_PATH` at the same file,
so the one-time migration (see [setup.md](./setup.md#migrating-from-worktrees))
runs and rewrites the config and `.data` stores in place on the first
`docker compose up`, leaving `*.pre-projects.bak` siblings. Preview it first with
`pnpm config:check --compose config/remote-agent-console.docker.json`, which maps
the Compose paths and reports bare program names as resolved at boot inside the
container. Under the host bridge, set `adapters.codex.program` to an absolute host
path: a bare name cannot be resolved from inside the container and the migration
refuses it.

## Add container-managed Projects

The repository checkout is already mounted at `/workspace`. Declare it, or any
other bind-mounted repository, as a Project in
`config/remote-agent-console.docker.json`; its Worktrees are discovered from git
inside the container:

```json
{
  "projects": [
    { "id": "remoteagents", "label": "Remote Agent Console", "path": "/workspace" }
  ]
}
```

The console also resolves its *own* checkout through this declaration — server
updates and stack status/log files run against the Project whose `path` is the
server's own checkout, using its `hostPath` under the host bridge.
`RAC_SERVER_CHECKOUT` names that checkout as the container sees it (the tracked
Compose file sets it to `/workspace`, since the packaged image runs from `/app`);
`RAC_HOST_REPOSITORY` (updates) and `RAC_HOST_WORKSPACE` (stack files) override
the host-side path explicitly. Nothing assumes the `/workspace` mount or a
`remoteagents` id any more. Preview hostnames are likewise served from the
discovered Worktrees, so a Project that fails to load — or the first moments
after boot, before discovery's first scan — answers 404 rather than proxying.

For additional Projects, copy `compose.override.example.yaml` to the ignored
`compose.override.yaml`, remove the host-tmux settings if they are not needed,
and add each repository bind under `/worktrees`. A Project's `path` must match
the container bind destination.

## Connect to the host tmux server

The bridge needs a **running host tmux server**, not just a socket file. After a
reboot, a stale socket can remain while no server is listening. The container
cannot restart that host process through its read-only socket mount; attempting
a launch then fails with `Address already in use` or `no server running`.

Run `id -u` and set `HOST_UID` in the ignored `.env` to that value; the example
assumes UID `1000`. Run the installer as that same user so Compose and recovery
use the same socket directory. Install the host-side recovery timer before
enabling the bridge:

```bash
TMUX_BIN="$(command -v tmux)" bash scripts/install-host-tmux.sh
sudo loginctl enable-linger "$(id -un)"
systemctl --user status remote-agent-tmux.timer
```

If Compose uses a custom `HOST_TMUX_DIR`, pass that same absolute directory to
the installer. `TMUX_BIN` must be the executable that runs **on the host**, not
a container-only `HOST_TMUX_BIN` compatibility wrapper. The installer does not
source `.env`. It starts the server immediately and checks again every 30
seconds, including after boot. It disables tmux's `exit-empty` so closing the
last agent does not remove the bridge. Socket storage is private without
changing the file permissions inherited by newly started agent processes.
Existing sessions are preserved.

New servers run in a separate, automatically collected user scope rather than
the repeating check's cgroup. The oneshot service retains `KillMode=process` to
preserve sessions from earlier installations. Reinstalling does not move an
existing server or change its inherited file-creation mask; an old server keeps
those settings until the operator restarts it, and can continue producing
leftover-process journal warnings until then. Disabling the timer with
`systemctl --user disable --now remote-agent-tmux.timer` does not stop agents or
restore `exit-empty`. It also does not restore conversations lost at reboot;
use the console's resume controls for those.

Copy `compose.override.example.yaml` to `compose.override.yaml` when the console
must discover and control Codex sessions already running on the host. The
override adds the host process tree, tmux socket, tmux client, Codex home, and
worktree mounts. For every host-backed Project:

- Set the Project's `path` to its container path.
- Set `hostPath` when the Main worktree's absolute host path differs from `path`.
  When omitted, host-backed launches inherit `path`.
- Add a matching bind mount to `compose.override.yaml`.
- Discovered Linked worktrees must be mounted at the **same absolute path**
  inside the container as on the host, and their common Git directory mounted at
  the path referenced by each worktree's `.git` file.
- Keep research-only checkouts read-only.

Creating, removing, and pruning Worktrees (the launcher's **New worktree…**,
**Remove**, and **N stale · Prune** controls) is available only for a Project the
container mounts at its host path — that is, when `hostPath` is absent or equal to
`path`. When they differ, git inside the container would write the container's
paths into the repository's worktree metadata, which the host could not follow,
so the console disables those controls and reports the reason. To manage such a
repository's Worktrees, run `git worktree add`/`remove`/`prune` on the host
instead; the console discovers the result on its next tick. Note too that a host
checkout the container does not mount looks *stale* from inside the container, so
the Prune confirm warns before clearing anything.

The host bridge is controlled by environment variables rather than image
assumptions:

| Variable | Purpose | Default |
| --- | --- | --- |
| `HOST_TMUX_BIN` | Host tmux executable or wrapper mounted into the container | `/usr/bin/tmux` |
| `HOST_TMUX_DIR` | Host tmux socket directory | `$HOME/.local/state/tmux/tmux-$HOST_UID` |
| `HOST_UID` | UID owning the host tmux server | `1000` |
| `RAC_HOST_NODE_BIN` | Optional absolute host Node.js executable for the Files broker | `node` from host PATH |
| `RAC_HOST_CODEX_BIN` | Host-visible Codex executable used by the update advisor | `adapters.codex.program` |
| `RAC_HOST_INTERACTIVE_SHELL` | Absolute zsh, bash, or fish path executed by the host tmux server | `/usr/bin/zsh` |
| `RAC_HOST_PATH` | Complete PATH exported before host agent and stack commands | `/usr/local/bin:/usr/bin:/bin` |
| `RAC_INTERACTIVE_SHELL` | Absolute zsh, bash, or fish path for container-managed sessions | `/usr/bin/zsh` |

The mounted tmux client must run inside the container and speak the same
protocol as the host server. On hosts whose tmux binary needs incompatible
runtime libraries, point `HOST_TMUX_BIN` at an installation-local wrapper and
add its binary and library mounts to the ignored override. The tracked image no
longer assumes Homebrew, an x86-64 loader, or a particular host library layout.

### Full-host Files access

When `RAC_HOST_NODE_BIN` is unset or blank, the Files broker resolves `node` on
the host using `RAC_HOST_PATH` when configured, otherwise the host tmux server’s
PATH. It does not use the container’s Node.js. To pin a particular version, set
`RAC_HOST_NODE_BIN` in the ignored `.env` to its absolute host executable path.
The Files panel uses a private host-user broker launched through tmux, rather
than limiting browsing to container bind mounts.
The container's numeric UID must match `HOST_UID` (the image defaults to 1000).
Filesystem operations inherit the host tmux account's supplementary groups;
they never use sudo or fall back to container permissions. Missing host Node,
UID parity, or proc/tmux/checkout mapping is reported as an unavailable bridge.

Files starts at the selected Place's host directory and can navigate anywhere
the host account can access. Filename clicks prefer the configured editor and
fall back to the browser Code preview when it is unavailable; row-body clicks
select entries. Files can open outside-worktree files in the editor using their
session-bound object capabilities. Raw editor paths from Code and review jumps
remain relative to their Place. Deletes are permanent and require confirmation.
Favorites persist per exact Place in `.data/file-favorites.json`; operation
recovery records persist separately in `.data/file-operation-journal.json`.

Mount the complete host `${HOME}/.codex` directory, not only `auth.json`. Codex
replaces credentials atomically during refreshes and account changes; a
single-file bind can remain attached to a stale inode.

Pull-request lookup also needs GitHub credentials inside the container. The
override example mounts the complete host `${HOME}/.config/gh` directory
read-only so GitHub CLI credential updates remain visible. This works when the
host `hosts.yml` contains an `oauth_token`; GitHub CLI credentials held only in
an operating-system credential store are not available inside the container.
In that case, set `RAC_GITHUB_TOKEN` in the ignored `.env` instead. Do not copy
a token into tracked Compose configuration.

## Add the optional Cloudflare Tunnel

1. Change `publicOrigin` in the Docker configuration to the canonical HTTPS
   origin, such as `https://agents.example.com`.
2. Copy `config/cloudflared.example.yml` to the ignored
   `config/cloudflared.yml` and configure the tunnel UUID and hostname.
3. Set `CLOUDFLARED_CREDENTIALS_FILE` in `.env` to the absolute credential JSON
   path.
4. Start the tunnel profile:

   ```bash
   docker compose --profile tunnel up -d --build
   docker compose --profile tunnel ps
   ```

Both services use host networking. The application remains bound to loopback,
and `cloudflared` provides the public ingress. Keep
`RAC_PROJECT_PROXY_HOST=127.0.0.1` on Linux host networking unless the container
runtime provides project ports through another stable name.

## Account configuration

Use **Global settings → Add account** after startup. The named `codex-home`
volume preserves container-local account files between rebuilds. Host-tmux
deployments should use the complete host Codex-home bind from the override so
host and console launches select the same account. Keep `RAC_CODEX_BIN` pointed
at the Codex executable inside the container, as shown in
`compose.override.example.yaml`, when adapter launch commands use host-only
wrapper paths.
Set `RAC_HOST_CODEX_BIN` to the corresponding host-visible executable for the
dedicated update advisor; container paths such as `/usr/local/bin/codex` are not
automatically visible to host tmux.

## Operations

```bash
docker compose logs -f remote-agent-console
docker compose --profile tunnel logs -f cloudflared
docker compose restart remote-agent-console
docker compose stop                 # prevents automatic restart
docker compose down                 # retains the Codex login volume
docker compose down -v              # also removes the Codex login volume
```

Set `CODEX_VERSION` in the shell or `.env` before building to use a different
Codex package version. The image default is defined in `compose.yaml`.

## Remote deployment

Keep `.env`, `compose.override.yaml`, `config/cloudflared.yml`, tunnel
credentials, and `config/remote-agent-console.docker.json` local to each host.
Deploy by updating and building inside the target checkout:

```bash
ssh target-host \
  'cd /path/to/remoteagents && git pull --ff-only && docker compose up -d --build && docker compose ps'
```

Add `--profile tunnel` to both Compose commands when that host uses the tunnel.
Do not synchronize a source tree, Docker image, generated web assets, or local
configuration between hosts. Each host pulls the same revision and builds with
its own ignored configuration.
