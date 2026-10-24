# Remote Agent Console — Usage

Installation, configuration, everyday workflows, and development instructions.
For the system architecture and engineering rationale, read the
[technical white paper](README.md).

> [!IMPORTANT]
> This is a **single trusted operator** console. It can send input to terminals
> and execute worktree commands as the host account. Bind it to loopback and
> publish it only through an authenticated HTTPS proxy or tunnel.

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Everyday controls](#everyday-controls)
- [Console workflows](#console-workflows)
- [Development](#development)
- [Repository layout](#repository-layout)
- [Documentation](#documentation)
- [Security and scope](#security-and-scope)

## Requirements

- Linux with `/proc`
- Node.js 22+ and pnpm
- tmux
- An installed and authenticated supported agent CLI for launches (Codex/OMX or
  Claude Code); adapters may remain unconfigured for observe-only use
- A C/C++ build toolchain for the native `argon2` dependency when running outside Docker
- An HTTPS reverse proxy or tunnel for access beyond the local machine

Docker Compose is the recommended deployment because it packages Node, Codex,
tmux, and the native build/runtime dependencies. It starts in an isolated
scratch-only mode; connecting to a host tmux server and adding a public tunnel
are separate opt-in steps.

## Quick start

### 1. Install and create configuration

```bash
git clone https://github.com/anstosa/remoteagents.git
cd remoteagents
pnpm install

cp .env.example .env
cp config/remote-agent-console.example.json ~/remote-agent-console.json
```

Generate the two required secrets:

```bash
node -e "require('argon2').hash('choose-a-long-password',{type:require('argon2').argon2id}).then(console.log)"
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Set `RAC_PASSWORD_HASH`, `RAC_SESSION_SECRET`, and `RAC_CONFIG` in `.env`, then
validate the scratch-only starter configuration:

```bash
pnpm config:check ~/remote-agent-console.json
```

### 2. Run directly

```bash
pnpm build
pnpm start
```

Open `http://127.0.0.1:8787`. Loopback HTTP is accepted only for local use;
every non-loopback deployment still requires canonical HTTPS.

### Or run with Docker Compose

Copy the scratch-only configuration into the ignored Compose location, then
start the console:

```bash
cp config/remote-agent-console.example.json config/remote-agent-console.docker.json
pnpm config:check --compose config/remote-agent-console.docker.json
docker compose up -d --build
docker compose ps
```

The default stack runs only the console and manages its own container-local
tmux sessions. Enable the optional Cloudflare sidecar with
`docker compose --profile tunnel up -d --build`.

After startup, use **Global settings → Add account** to connect one or more
ChatGPT accounts through device-code login and select the active Codex login.
Failed account queries offer **Re-login** without changing the active account.
Use **Rename** beside any saved account or API key to change its display name
without switching credentials. API-key rows show spending for today and this
week when optional [OpenAI billing access](docs/accounts.md#api-key-spending) is
configured; missing billing data is shown as unavailable, never as zero.

Connecting Docker to existing host tmux sessions requires host-specific bind
mounts, worktree paths, and runtime settings. Follow the
[Docker Compose guide](docs/docker.md) for that optional bridge and for tunnel
setup. Keep host values in ignored `.env`, `compose.override.yaml`, and
`config/` files.

### Or run with systemd

To run directly as the host user, use the portable user-unit installer in the
[systemd deployment guide](docs/systemd.md). Native execution connects to the
user's tmux socket and Codex configuration without Docker bind mounts.

## Configuration

The `projects` array may be empty or omitted for scratch-only use. Each Project
is a git repository with a stable ID, canonical path, and label; its Worktrees
are discovered from `git worktree list`. Optional fields expose project links,
stack actions, new-task flows, and customized prompt actions, plus a
`commands.setup` that prepares each freshly created Worktree (for example
`pnpm install`) before its agent launches. Agents launch by
Adapter kind — `codex`, `omx`, `claude`, and later `pi` and `opencode` —
configured once under `adapters`; Codex and OMX are separate kinds, so a
deployment can run plain Codex in some worktrees and OMX in others.

```json
{
  "listen": { "host": "127.0.0.1", "port": 8787 },
  "name": "My server",
  "publicOrigin": "https://agents.example.com",
  "remoteServers": [
    { "url": "https://other-agents.example.com" }
  ],
  "adapters": {
    "codex": {
      "program": "/usr/local/bin/codex",
      "args": ["-c", "check_for_update_on_startup=false"],
      "updates": {
        "current": "/usr/local/bin/codex --version | awk '{print $2}'",
        "latest": "npm view @openai/codex version",
        "run": "/usr/local/bin/codex update"
      }
    },
    "omx": {
      "program": "/absolute/path/to/omx",
      "args": ["-c", "check_for_update_on_startup=false"],
      "env": { "OMX_AUTO_UPDATE": "0" },
      "updates": {
        "current": "/absolute/path/to/omx version | sed -n '1s/^oh-my-codex v//p'",
        "latest": "npm view oh-my-codex version",
        "run": "/absolute/path/to/omx update --stable"
      }
    }
  },
  "projects": [
    {
      "id": "my-project",
      "label": "My project",
      "path": "/absolute/path/to/project",
      "newTask": "detach && new {taskId}",
      "push": { "label": "Finish and PR", "prompt": "$finish" }
    }
  ]
}
```

`name` identifies the current Remote Agents server. Remote entries require their
canonical URL and may include optional local `name` and `icon` overrides. Without
an override, each server's identity comes from its authenticated peer-status API.
In Application settings, leave Name blank or select **Server Default** for Icon
to remove the corresponding override; the controls remain visible and show the
published defaults. Save changes persists these choices to config, and a RAC
restart applies them to navigation. Overrides affect only this console's display
of the remote, never the remote server's own published identity.

Only the terminal icon is bundled. Custom `heart` and `potato` SVGs are
server-local files named `heart.svg` and `potato.svg` in an `instance-icons/`
directory beside the file selected by `RAC_CONFIG`. The favicon and server menu
load those files at request time; a missing file uses the terminal icon instead.
Keep custom artwork out of Git and provision it separately on each host. The
Compose checkout's `config/instance-icons/` directory is ignored by Git and
excluded from the build context; its runtime bind mount makes the files available
without baking them into the image.

Upgrading from an older `worktrees[]` configuration is automatic: start the
console once and it migrates the config and its `.data` stores to Projects,
leaving `*.pre-projects.bak` backups. Preview the plan with
`pnpm config:check "$RAC_CONFIG"`, or migrate a read-only config in place with
`pnpm config:migrate "$RAC_CONFIG"`. See
[Migrating from `worktrees[]`](docs/setup.md#migrating-from-worktrees).

See [the setup reference](docs/setup.md) for the full security boundary,
Projects and Worktrees, browser capabilities, and operational checks.

### Adapter launch behavior

Each agent CLI the console understands is described by one **Adapter**: a module
that says how to recognise its processes, read its state, compose a launch,
submit a prompt, and find its conversations, while the console performs every
side effect through its single tmux and `/proc` layer. Each agent CLI is
configured once under [`adapters`](docs/setup.md#adapters); the console composes
each launch as `[program, …adapter.launch(input).args, …operator args]` with the
operator's environment and runs it through the operator's interactive shell. An
entry may also carry `setup`/`teardown` lifecycle commands, run before each
launch (aborting it on failure) and best-effort after each console-driven
stop, plus `updates` commands that move version checks and explicit upgrades
into Global settings. See
[ADR 0002](docs/adr/0002-adapters-describe-the-console-acts.md) for why adapters
describe and the console acts; the [`docs/adr/`](docs/adr) directory records the
other architecture decisions.

## Everyday controls

| Control | Action |
| --- | --- |
| `Enter` | Queue the current prompt |
| `Shift+Enter` / `Ctrl+Enter` / `⌘+Enter` | Insert a newline |
| `↑` / `↓` | Recall older/newer prompt history when the cursor is on the first line |
| `Ctrl+S` / `⌘+S` | Save the current prompt as a draft |
| `Tab` | Insert a tab in the prompt; when pane input is focused, send Tab to the pane |
| `$` or `/` | Open skill or slash-command completion |
| `Ctrl+C` with selected output | Copy the selection; without a selection when pane input is focused, interrupt the process |

## Console workflows

| Area | Capabilities |
| --- | --- |
| **Agent overview** | Discover Codex, OMX, and Claude Code processes in tmux, see working/finished/question state, unread activity, and launch configured or scratch agents. |
| **Live output** | Stream the active pane, scroll through retained output, open detected links, copy selected output, answer guided questions, and type directly into the pane. |
| **Prompt workflow** | Use per-agent prompt history, arrow-key recall, saved drafts, attachments, skill/slash-command autocomplete, press-and-hold voice dictation, and persistent queued prompt management. |
| **Worktree context** | Show branch and full Git status, changed filenames, pull-request checks and review issues, GitHub Actions, project links, and trusted stack commands. |
| **Conversations and notes** | Name, list and resume each agent's own Conversations from the console, and keep autosaved Markdown notes with reusable file attachments beside output. Both are shared automatically across a Project's worktrees. A note's **Show in all workspaces** option also makes it available in other Projects and Scratch. |
| **Guided review** | Generate an AI-narrated tour of active Working or All PR implementation changes, visit or skip each logical step, and send consolidated feedback to the agent. |
| **Operations** | Install as a browser app, enable notifications, review stale runtime cleanup targets, and deploy with Docker Compose plus an optional Cloudflare Tunnel. |
| **Files** | Browse the ordinary host account's filesystem from any Place, open files in the configured editor or browser Code fallback, manage files with explicit delete/conflict confirmation, download files or ZIPs, and save favorites per exact Place. |
| **Conversational control** | Connect ChatGPT through scoped remote MCP or use the built-in OpenAI Realtime voice dialog to inspect and direct the same agents. |

### Review implementation changes

Open the branch-status flyout, choose **Working** or **All PR**, then select
**Review**. For a new tour, the start sheet lets you choose whether to include
tests and documentation, select the tour's effort, and optionally add an AI
Code review with a preset. The console captures a fresh Git comparison and
generates a narrated tour explaining how related changes fit together. Opening
an existing tour skips the start sheet; start again to change its comparison.

The tour itself is explanatory: it does not produce findings, verdicts, or
patches. The optional Code review proposes findings that you **Keep** as editable
comments or **Dismiss**; untriaged findings are not sent. Visit or skip every
logical step, add feedback where useful, then optionally send one editable
consolidated change request to the active agent. Generation runs as a bounded,
cancellable job and the tour requires regeneration if the underlying changes move.

Use **Ask reviewer** on a supported anchored finding, or **Ask guide** on selected
diff lines, to ask a follow-up in the original agent conversation. These turns
retain read-only restrictions. See [Reviews](docs/setup.md#reviews) for agent,
run-mode, and review-preset configuration.

### Manage follow-up prompts

Prompts submitted while an agent is busy are stored for that agent, not shared
with other agents in the same worktree. The clock attached to **Queue** opens an
oldest-first list where prompts can be reordered, edited, or cancelled before
they are dispatched. See [ADR 0012](docs/adr/0012-queued-prompts-and-history-belong-to-the-agent.md)
for restart handoff and recovery when an agent disappears.

![Queued prompt management flyout with reorder, edit, and cancel controls](docs/images/queued-prompts.png)

### Keep context beside the output

Notes are persistent, autosaved, and rendered as Markdown. On wider screens
they share the output area; on narrow screens the layout adapts vertically.

![Live agent output beside a Markdown worktree note](docs/images/worktree-notes.png)

### Clipboard access in project previews

Managed project previews forward `navigator.clipboard.readText()`, `writeText()`,
`read()`, and `write()` through the console, like location and notifications.
The prompt identifies the requesting origin and separates clipboard reading
from writing. Choose **Allow once**, **allow always**, or **deny**; **Reset preview
permissions** removes the origin's saved approvals. Other previews and standalone
pages retain their native clipboard APIs.

Browser permission, focus, and activation requirements still apply. A saved
approval can require another consent click when activation has expired, and
native denials are returned without retrying. Reset or navigation suppresses late
results but cannot undo a native write already started. Rich reads use the browser's
default sanitization and return a snapshot; read options are not supported.
Transfers are limited to 1,048,576 text characters, four items, eight formats per
item, and 4 MiB of rich data. Native format and multi-item support still depend
on the browser and operating system. See the [Clipboard API security
requirements](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API#security_considerations).

### Browse and manage files

Open **Files** from the desktop Workspace toolbar or the mobile three-dot menu.
It starts at the selected Place's host folder and can navigate outside it.
Click a filename to open it in the configured editor, or in Code when no editor
is configured or an editor terminal cannot be opened. This also works outside
the worktree. Click the rest of its row to select it. Ctrl/Command toggles
selection and Shift selects a range; mobile row taps toggle multiple entries.
Rows include owner, permissions, modification time, and readable size. Sort any
metadata column; Name starts ascending with
directories first. The titlebar path field follows navigation and accepts an
absolute path with Enter.

The upper-right controls contain Parent, New, Upload, and Favorites. Row
three-dot menus act only on that row. Right-click a selected row to act on the
selection, an unselected row to act on that item, or unused space to act on the
current directory. These menus provide rename, copy/cut/paste, and file or ZIP
downloads. Deletes are permanent and require confirmation; collisions require
**Replace**, **Skip**, or **Keep both**. Favorites persist on the server for
each exact Place, independently of other worktrees in its Project. Docker's
full-host Files access requires the private host-user broker described in the
[Docker guide](docs/docker.md#full-host-files-access).

Listings show up to 10,000 entries. Recursive operations and downloads are
bounded to 10,000 objects and 1 GiB; uploads allow up to 100 files, 1 GiB per
file and 2 GiB per batch. Code previews read up to 5 MiB. Operations report
explicit limit errors and identify any partially completed work.

<details>
<summary><strong>Mobile layout</strong></summary>

![Remote Agent Console mobile layout](docs/images/mobile-console.png)

</details>

## Development

```bash
pnpm install
pnpm dev

pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Browser behavior is covered with Playwright specs under `apps/web/e2e`.
The white paper uses an operator-supplied workspace screenshot. Supplemental
workflow screenshots are deterministic and use synthetic data:

```bash
pnpm --filter @rac/web screenshots:readme
```

This command does not replace the operator-supplied workspace screenshot. See
[screenshot provenance](docs/images/README.md) for details.

See [CONTRIBUTING.md](CONTRIBUTING.md) before changing discovery, authentication,
tmux input, or worktree command boundaries.

## Repository layout

```text
apps/server/   Fastify API, tmux discovery/input, persistence, and integrations
apps/web/      React/Vite browser UI and Playwright coverage
config/        Example application and Cloudflare Tunnel configuration
docs/          Deployment guides and README screenshots
compose.yaml   Local production stack
```

## Documentation

- [Setup, configuration, and browser capabilities](docs/setup.md)
- [Docker Compose deployment](docs/docker.md)
- [systemd deployment](docs/systemd.md)
- [Using an existing Cloudflare Tunnel](docs/cloudflare-tunnel.md)
- [ChatGPT, MCP, Realtime voice, and federation](docs/integrations.md)
- [Security policy and deployment expectations](SECURITY.md)
- [Contributing and validation](CONTRIBUTING.md)

## Security and scope

Remote Agent Console is intentionally not a general-purpose web terminal or a
multi-user collaboration service. It is a focused remote control surface for
one operator's coding-agent workspaces. Authentication, strict Host/Origin checks,
short-lived WebSocket tickets, bounded caches, and target revalidation reduce
risk, but the console still inherits the privileges of the host account that
runs it.
