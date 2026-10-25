# Remote Agent Console setup

## Security boundary

This is a **single trusted operator** console: terminal and prompt access execute code as the Unix account running the server. It binds only to loopback; never expose it directly to the Internet. Loopback HTTP is supported for local evaluation only. Publish the console beyond the local machine only through an HTTPS reverse proxy or tunnel that preserves the configured Host and Origin.

### Browser control and reconnection

Only one authenticated browser controls a console at a time. Losing a connection,
letting a device sleep, or restarting RAC does not release that ownership: the
same browser reconnects automatically. If another browser takes control, the
previous browser must click **Take control** before it can use the console again.
Signing out releases control only when that browser still owns it.

RAC keeps the last controller in `.data/control-owner.json` under its server
checkout (`RAC_SERVER_CHECKOUT` when configured). The private record stores no
credentials or live connection lease. Keep it with the checkout's other runtime
state across deployments. On the first upgrade to this behavior, an existing
signed-in browser must take control once to establish the record. Invalid or
unreadable records prevent startup rather than silently forgetting ownership.

## Prerequisites

Linux with `/proc`, tmux, Node 22+ (Node 24 is supported), pnpm, a C/C++ build toolchain for the native `argon2` dependency, and an existing agent CLI (Codex by default). Configure each CLI the console launches under [`adapters`](#adapters).

```bash
pnpm install
cp config/remote-agent-console.example.json ~/remote-agent-console.json
# The starter configuration is valid scratch-only loopback HTTP.
node -e "require('argon2').hash('choose-a-long-password',{type:require('argon2').argon2id}).then(console.log)"
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
export RAC_PASSWORD_HASH='paste-the-argon2id-hash'
export RAC_SESSION_SECRET='paste-unique-32+-random-base64url-bytes'
export RAC_INSTANCE_STATUS_SECRET='paste-shared-32+-random-base64url-bytes'
export RAC_CONFIG="$HOME/remote-agent-console.json"
pnpm config:check "$RAC_CONFIG"
pnpm build
pnpm start
```

Open `http://127.0.0.1:8787`. Leave `projects` empty or omit it entirely to
launch scratch agents without configuring a repository. By default a scratch
agent starts in the console's home directory; set the top-level
`scratchDirectory` (an absolute path) to launch it elsewhere. The account home
the shell exports is unaffected — only the working directory changes. The
Scratch folder is also a Place: every pane under it that is outside a
configured Project (an Agent started by hand, a terminal) belongs to it, and its
notes and terminals are shared. With `scratchDirectory` unset that folder is the
home directory itself, so every such pane anywhere under it lands in the one
Scratch Place; set `scratchDirectory` to keep it narrow. A pane outside both the
Scratch folder and every Project is a Scratch Place of its own. A git repository
is the exception: an agent started by hand in an unconfigured repository, inside
the Scratch folder or anywhere else, gets its own tab as an **implicit Project**
(see [Projects](#projects)). Before
publishing the console, replace `publicOrigin` with its canonical HTTPS origin.

Set the top-level `editor` to a command line such as `"/usr/bin/nvim"` to add
an Editor button to the Workspace toolbar, beside Terminal. It opens a new
Console shell at the Place and runs the command in it once the shell is up;
quitting the editor ends the shell and closes its Terminal, even if your tmux
configuration sets `remain-on-exit`. The command runs in the operator's
interactive shell, never sandboxed, and is never sent to the browser.

The same `editor` adds an editor button to each file header in the Code panel
and in a guided review. It opens the working tree's copy of that file at the
selected line, or at the diff's first change when no line is selected (the
top of a file in the File view), by appending
`+LINE 'path'` to the command. vim, nvim, emacs, nano, micro and kakoune all
understand that form; an editor that wants another one (VS Code's `-g
path:LINE`, say) is not supported by the jump.

### Browser preferences

In **Settings → This browser**, Name, terminal font, theme, reduced motion,
notification sounds, flyout markers and dynamic worktrees remain drafts until the top-right
**Save changes** action. **Done** in the Rename dialog stages the name; it does
not save it. **Validate** does not apply preferences, and **Discard changes**
restores the currently applied values. Browser-only saves remain available
when installation files cannot load. When saving browser and file edits
together, failed file validation or saving leaves browser preferences unapplied.

Settings lists start as compact item summaries. Use **Edit** to open an item's
fields; closing the editor keeps its staged changes. Arrow buttons reorder
ordered lists, the trash button removes an item, and **Add** opens a new item
for editing. These actions still use the global **Save changes** button.

Settings with a code-defined default always show their controls, even when omitted
from the config file. Viewing them does not write defaults into the file; editing
stages only the changed values and any default container needed to preserve its
other items. Boolean switches sit to the right of their label and description.
Restart guidance appears in the non-dismissable **Restart pending** toast after
saving, rather than on individual settings or pages. Successful saves show a
temporary **Saved** toast that dismisses after five seconds.
Recovery details appear only after the host begins restarting RAC. The live
countdown uses the host watchdog deadline and continues while RAC is offline.
Completion shows a dismissible **Server restarted successfully** toast, or a
warning when RAC had to recover after a failed restart. Dismissing that outcome
does not dismiss any saved changes that still require a restart.

Restarting RAC arms a temporary three-minute watchdog in the host settings
worker, independent of the RAC process and browser. The watchdog requires a new
RAC boot with the expected settings and a healthy local listener; the old running
process does not count as a successful restart. If RAC does not return in time,
the worker stops the forward restart commands and automatically runs the same
last-known-healthy recovery used by the host recovery command. Recovery retains
the saved settings so they can be corrected and retried. Cloudflare-only
operations do not arm the RAC watchdog.

### Add Cloudflare remote access from Settings

Start RAC locally first, then open **Settings → Cloudflare**. Token onboarding is
available for Docker installations with the host settings applier installed.
It uses a remotely managed tunnel; no Cloudflare account API token is needed.
Native installations retain management of an already installed tunnel service.

1. Open the [Cloudflare dashboard](https://one.dash.cloudflare.com/), go to
   **Networking → Tunnels → Create Tunnel**, choose **Cloudflared** if asked,
   and name the tunnel.
2. In **Setup Environment / Install and Run**, copy **only the tunnel token**
   from the installation command. Do not execute the command: RAC runs its own
   connector. Paste the token into Settings and select **Start connector**.
   This leaves RAC at its existing address and does not remove a legacy tunnel.
3. After Cloudflare shows the connector online, select **Continue**. Add a
   **Published application** route under **Routes → Add route** (called
   **Public Hostname** in older dashboards).
4. Choose a hostname under your Cloudflare-managed domain. Copy the **Service
   URL** shown in RAC Settings; the default is `http://127.0.0.1:8787`. If the
   dashboard splits the fields, choose **HTTP** and enter `127.0.0.1:8787` in
   **URL**, using your configured RAC port. This loopback address works because
   the managed connector uses host networking. Save the route.
5. Enter the same hostname in RAC and select **Verify and use hostname**.
   Confirm the address change. RAC compares a fresh local and public health
   proof before changing `publicOrigin` or restarting itself. Verification
   failure leaves the existing public origin unchanged so the route can be
   corrected and retried.
6. Open the verified HTTPS address and sign in again. Keep the original page
   open until setup succeeds; the restart watchdog provides host recovery.

The panel includes **Copy setup instructions**, **Copy service URL**, and
**Copy hostname** buttons. Saved tokens are never sent back to the browser and
are mounted into the connector as private, read-only token files rather than
command-line arguments. Leave the token field blank to reuse a saved token.
Existing tunnels show their configured endpoint, connector **Up/Down** status,
and expandable **Configuration files**. Select **Replace tunnel** to reopen the
setup guide; opening it does not change the running tunnel. Existing file-managed
tunnel sources remain editable in that disclosure. Remotely managed routes stay
in Cloudflare rather than an invented local configuration file.
Installation checkout handover is blocked while a managed token connector is
active, rather than risk leaving its private credential in the old checkout.

Cloudflare Access must allow the unauthenticated `/healthz` route during this
verification; a redirect or Access login page is not a healthy RAC response.
Published application routes are Internet-facing, so retain RAC authentication
and configure any additional Access policy deliberately. See Cloudflare's
[setup guide](https://developers.cloudflare.com/tunnel/get-started/) and
[token-file documentation](https://developers.cloudflare.com/tunnel/reference/run-parameters/#token-file).

### Keyboard shortcuts

The web app's shortcuts work like tmux key tables. `root` is always active, and `C-b` switches to the `prefix` table for one key: `c` opens a Terminal, `1`–`9` and `0` go to a panel, `n`/`p`/`l` step through panels, `w` and `s` pick a Workspace, `z` expands the current panel, `x` closes it after a y/n question, `g` opens Lazygit, `:` opens the command palette and `?` lists every binding. Press `C-b` twice to send it to the focused terminal. A table waits 10 seconds for its key, and a floating indicator above the active split’s input controls shows shortcut attempts in purple and consumed bindings in green. Ordinary typing in prompts, notes, terminal output, and other fields stays hidden, as do modal and shortcut-recorder keystrokes. Leader keys remain visible while their table waits; the completed command appears alongside its leader and the whole sequence fades together. `Ctrl+?` or **Settings → Keyboard shortcuts → View active shortcuts** opens the bindings sheet, which groups every command’s shortcuts together. Direct bindings have no table label; prefixed bindings show their prefix table. Disabled commands keep their description struck through and hide their keys and edit buttons. The sheet is read-only; **Edit in Settings** opens the server’s dedicated Keyboard shortcuts settings section. Simultaneous keys are separated by **+**, with each key in its own outline and familiar modifier labels: Ctrl, Alt, Shift, and Win on Windows, Cmd on macOS, or Super elsewhere.

In **Settings → Keyboard shortcuts**, select the pencil beside a binding, press the replacement keys and select **Apply shortcut** to stage the edit. **+ Add** stages another assignment; the red trash icon removes one. **Use prefix** chooses a direct shortcut or a leader table, and a custom dropdown selects among configured prefix tables. **Disable**, **Enable**, **Reset** and **Reset all shortcuts** also stage config changes. Reset restores built-in assignments rather than browser preferences. Browser-reserved and unsafe typing keys remain rejected; a chord already assigned to another command cannot be overwritten by the recorder.

The application config file’s `keys` field is the source of truth for this server. All shortcut changes use the top-right **Save changes** button together with other staged Settings edits; they never write browser-local shortcut preferences. **Discard changes** restores the saved file values, and failed validation or a revision conflict retains the draft. Keyboard changes require a server restart: the non-dismissable **Restart pending** notice supplies the explicit restart action, while the quick reference and active shortcuts continue to use the running server’s bindings until then. Legacy browser overrides are ignored and are not automatically promoted to server-wide settings. **Advanced key tables and terminal commands** edits the same file-backed keys, including exact terminal commands and protected credential values. The recorder preserves full unmasked terminal commands when moving them; masked commands must be edited through the advanced controls rather than copied from a redacted dashboard label. Native editor navigation and terminal/CLI keys are unchanged.

The top-level `keys` adds tables and bindings, replaces default bindings, and removes them with `null`:

```json
"keys": {
  "root":   { "C-b": { "table": "prefix" }, "C-g": { "table": "git" } },
  "prefix": { "x": null },
  "git":    { "l": { "terminal": "lazygit", "reuse": true }, "d": { "terminal": "gh dash" } }
}
```

- Chords use tmux's syntax: `C-` (Ctrl), `M-` (Alt), `S-` (Shift) and `Super-` (Win on Windows, Cmd on macOS, Super elsewhere), then a character (`?`, `%`, `L`) or a named key (`Left`, `Space`, `F1`). A key matches the character typed, so an uppercase letter is the same as `S-` plus the lowercase letter.
- A binding is an action name such as `"next-panel"` (the command palette lists them), `{ "table": name }`, or `{ "terminal": command, "reuse"?: bool }`. A terminal binding opens a Terminal in the current Workspace that runs the command and closes when it exits. With `reuse`, the key focuses that Terminal while it runs instead of opening another. The browser sends only the binding's table and key; the command stays on the server.
- A binding in `root` needs `C-`, `M-` or `Super-`, or a function key, so it cannot steal ordinary typing.
- The console refuses to start on a chord a browser keeps for itself (`C-t`, `C-n`, `C-w`, `C-q`, `C-S-t`, `C-S-n`, `C-S-w`, `C-Tab`, `C-S-Tab`, `C-PageUp`, `C-PageDown`, `C-S-p`, `C-S-u`, `C-]`), and on a binding to a table that does not exist.

When `remoteServers` connects multiple console instances, configure the same
separately generated `RAC_INSTANCE_STATUS_SECRET` on every peer. Keep each
instance's `RAC_SESSION_SECRET` unique: it signs browser sessions and must not
be reused as the federation credential. The status API exposes only the
server's published name and icon plus aggregate question, completed, idle, or
unavailable attention. It rejects unsigned or stale peer requests.

To run the console and its managed tmux/Codex sessions in Docker instead, see
[the Docker Compose guide](docker.md).

## Adapters

Each agent CLI the console launches is configured once under `adapters`, keyed
by kind (`codex`, `omx`, `claude`, `pi`, `opencode`). The console launches a kind by
prepending its `program` to the adapter's own arguments and appending the
operator's, so a checkout never chooses a program — adapter configuration is
global:

```json
{
  "adapters": {
    "codex": { "program": "/usr/local/bin/codex" },
    "claude": { "program": "/usr/local/bin/claude", "args": ["--model", "opus"], "env": { "SOME_VAR": "1" } }
  }
}
```

Each entry is `{ program, args?, env?, setup?, teardown?, updates? }`. `program` must be an
**absolute path to a real executable** (not a version-manager shim that needs a
shell); `args` (≤64) and `env` (names `^[A-Za-z_][A-Za-z0-9_]*$`) are the
operator's additions. Values are never shell-expanded — the console shell-quotes
them — so there are no placeholders, and `env` is not a place for secrets.
Configuring zero adapters — an empty or omitted block — is valid: the console
then only observes hand-started agents. Adding a kind whose program is missing
or not executable does not stop the server; that kind shows as unavailable in
**Global settings → Agents** with the reason, and every other kind still
launches. `pnpm config:check` reports the same non-fatal warning.

`setup` and `teardown` are optional shell-interpreted lifecycle commands for
host- or operator-specific shims. `setup` runs in the launched pane through the
same login shell as the agent, in the launch directory (the worktree for a
worktree launch, the home directory for Scratch), before the program; a non-zero
exit stops the agent from ever starting — the failure is visible in the pane.
`teardown` runs after the console stops a running agent of the kind (Turn off,
Restart), in the stopped agent's folder, best-effort: a failure is logged and
never blocks the stop. Unlike `setup`, `teardown` runs through the tmux server's
`sh` with the server's environment, not your login shell, so it does not see
profile-only `PATH` entries — keep it to absolute paths and plain commands. On
Restart both fire, so make the commands idempotent.

`updates` is an optional all-or-nothing object with three trusted shell commands:
`current` prints the installed version, `latest` prints the newest upstream
version, and `run` performs the update. The first non-empty output line from each
version command must be a valid semantic version. Global settings shows the
installed version, offers **Update** only when the upstream version has greater
semantic precedence, and aggregates any available agent update into a purple dot
on the settings gear. Checks are cached for 15 minutes; invalid or failed checks
do not expose shell output to the browser.

Browser updates run as background operations with short status-polling requests,
so a slow package installer does not have to hold a tunnel request open. Only one
agent installation runs at a time; retrying the same active update resumes its
status instead of launching another installer. If the console restarts and loses
the operation status, check the installed versions before retrying.

Use adapter launch settings to disable each CLI's own startup updater once this
surface is configured. Codex accepts
`"args": ["-c", "check_for_update_on_startup=false"]`; OMX should receive the
same Codex argument plus `"env": { "OMX_AUTO_UPDATE": "0" }`. The explicit
`updates.run` command remains available even though launch-time checks are off.

### OMX

OMX (oh-my-codex) is its own kind, configured under `adapters.omx` with the real
OMX executable — for a mise install that is `node_modules/.bin/omx` inside the
install, not the mise shim. Codex and OMX sit side by side, so some worktrees
can run plain Codex and others OMX: the Launch menu offers both, and the console
remembers which one each worktree used last. The console launches OMX with
`--direct` (OMX's direct policy, which runs the Codex TUI in the pane and manages
no HUD panes) and forwards Continue and Conversation resumes as `resume --last` and
`resume <id>`; `--direct` and `--tmux` are reserved, so a copy in `args` is
dropped with a boot warning. An OMX pane is badged OMX, the plain-Codex team
workers OMX spawns stay hidden from the dashboard, and a listed Codex Conversation
resumes under the kind the worktree last used (codex or omx).

The Codex-only features — ChatGPT accounts, update advisor, the app-server
command catalog — still read `adapters.codex`; an OMX-only configuration does
without them. The review tour is not one of them: it runs on the agent
[`review.tour`](#reviews) names, so an OMX-only configuration can generate tours
with Claude. A `codex` entry whose program is actually OMX
(the pre-split configuration) still launches, but as the wrong kind; the console
warns at boot and in `pnpm config:check`.

### OMX on ZFS

The console stops agents by killing their pane, which leaves OMX's session
pointer (`<worktree>/.omx/state/session.json`) pointing at a dead session. OMX's
own recovery needs `renameat2(RENAME_NOREPLACE)`, which ZFS lacks, so every
following launch aborts with `session_pointer_unusable`. Configure the pointer
cleanup as the OMX adapter's lifecycle commands:

```json
{
  "adapters": {
    "codex": { "program": "/usr/local/bin/codex" },
    "omx": {
      "program": "/absolute/path/to/omx",
      "setup": "rm -f .omx/state/session.json",
      "teardown": "rm -f .omx/state/session.json"
    }
  }
}
```

`setup` alone is sufficient (it is the guaranteed pre-launch repair); `teardown`
keeps the checkout tidy between launches and, being keyed by kind, never fires
for a plain Codex stop. Relative paths in either command resolve against the
directory the command runs in — the worktree for `setup`, the stopped agent's
folder for `teardown`.

The program is launched from an interactive zsh shell by default. Set
`RAC_INTERACTIVE_SHELL` for container or direct sessions and
`RAC_HOST_INTERACTIVE_SHELL` for host-tmux sessions. Absolute zsh, bash, and
fish paths are supported; each loads the operator's normal configuration
(`.zshenv`/`.zshrc`, `.bashrc`, or `config.fish`) before starting the agent. The
agent command itself always runs as POSIX shell, so operator `setup`/`teardown`
and `newTask` snippets stay in POSIX syntax regardless of the interactive shell.

New console-created headless panes with default tmux styles receive Mocha default
foreground/background colors before their shell or agent starts. This lets programs
such as Codex query both terminal colors during startup instead of falling back to
monochrome output or a gradient blended against the wrong background. Existing
panes, custom tmux styles, and sessions with an attached real terminal are not
restyled. Browser-local Light/Dark appearance does not change this shared startup
fallback. Programs that already cached missing terminal colors retain that state
until a new session starts.
Set `RAC_HOST_PATH` to a complete PATH when host commands require executables
outside the host shell's normal startup environment.

When `adapters.codex` is configured it also becomes the Codex binary that
container-local or direct headless Review runs and ChatGPT account management
use; `RAC_CODEX_BIN` overrides it. Headless Claude Review runs likewise use
`adapters.claude.program`, overridden by `RAC_CLAUDE_BIN`. A host-tmux update advisor instead uses
`RAC_HOST_CODEX_BIN`, falling back to the host-side `adapters.codex.program`.
The advisor inherits `adapters.codex.args` and `adapters.codex.env`, including
account/profile selection, even with an executable override. Its approval,
sandbox, terminal, and working-directory flags replace conflicting adapter
flags so the review stays in the server checkout. `setup` runs only when the
advisor uses the configured executable.
With neither applicable value set, the Codex-only feature reports unavailable
rather than spawning a bare `codex` from `PATH`. The **Global settings** flyout
shows the ChatGPT accounts section only when `adapters.codex` is configured.

If the installed Codex supports `--no-daemon`, add it to `adapters.codex.args`
to keep normal Codex launches and the advisor off the shared background server.
This is useful after switching accounts when that server still holds the
previous login. Existing agents are not restarted by this setting.

The console remembers the last kind launched in each worktree (and in Scratch)
and offers it first next time; with a single configured kind that is simply that
kind.

### Claude Code

```json
{ "adapters": { "claude": { "program": "/usr/local/bin/claude" } } }
```

With `adapters.claude` configured, launching Claude Code from the console gives
accurate Attention state, Enter-submitted prompts, safe interrupts, and named
Conversations. The console never touches anything under `~/.claude`: on every launch
and resume it passes `--settings` pointing at a console-owned file it renders at
boot into `<RAC_ADAPTER_FILES_DIR ?? .data/adapters>/claude/hooks.json`. That file
**only adds hooks** — Claude merges hook entries across settings levels, so your
own settings are unchanged. The hooks map Claude's lifecycle events to the
console's Attention states by running `scripts/hooks/rac-attention`, which writes
the tmux pane options the console polls. Do not put `--settings`, `--continue`,
`--resume`, `--session-id`, `-p`/`--print`, `--bare`, or `--safe-mode` in
`adapters.claude.args`; the console composes those itself and drops them with a
boot warning.

To get the same state and Conversation naming for Claude sessions you start **by hand**
(the console reads a hookless session as permanently *finished* and cannot name
it), add the same script as an optional dotfile hook in your own
`~/.claude/settings.json`, for example on `UserPromptSubmit`:

```json
{ "hooks": { "UserPromptSubmit": [ { "hooks": [ { "type": "command", "timeout": 5, "command": "/absolute/path/to/remoteagents/scripts/hooks/rac-attention working" } ] } ] } }
```

`rac-attention` exits 0 doing nothing unless it is inside a tmux pane and a tmux
binary resolves (`$RAC_TMUX_BIN`, else `tmux` on `PATH`), so it stays harmless in
shared dotfiles on hosts without the console.

To also render Claude's `AskUserQuestion` dialog as an Inline question (numbered
choice buttons the console answers with one tap), add a `PreToolUse` hook matching
`AskUserQuestion` that passes `--payload` — the flag makes `rac-attention` store the
hook's stdin (the question body) in the `@rac_question` pane option the console
reads (ADR 0006). A payload over 64 KiB is dropped, and any later report without
`--payload` clears it:

```json
{ "hooks": { "PreToolUse": [ { "matcher": "AskUserQuestion", "hooks": [ { "type": "command", "timeout": 5, "command": "/absolute/path/to/remoteagents/scripts/hooks/rac-attention question --payload" } ] } ] } }
```

**Known limitations.** A directory Claude has never opened shows its trust dialog
on first launch — the console never pre-accepts it, so UI-created worktrees hit it
once. A hookless session (see above) reads as *finished* and cannot be named from the console. Any
text already in the input box concatenates with a console paste. Under the
[host bridge](docker.md), set `RAC_HOST_REPOSITORY` to the host checkout path;
without it `claude` (and `pi`) show as unavailable, because the injected file paths
must be the ones the host-side agent sees. The console writes the rendered files
under `<RAC_HOST_REPOSITORY>/.data/adapters` (or `RAC_ADAPTER_FILES_DIR`); that
directory must resolve to the same bytes inside the container and on the host — a
bind mount at the same path, or an explicit shared `RAC_ADAPTER_FILES_DIR` — so the
host-side agent reads the file the container wrote.

## Reviews

The guided **Review tour** and the opt-in AI **Code review** are both a *Review
run*: one prompt sent to one agent in the Worktree, which answers with JSON the
console validates (ADR 0010). Only `codex` and `claude` can run one. The optional
`review` section chooses how:

```json
{
  "review": {
    "agents": { "claude": { "mode": "interactive" }, "codex": { "mode": "headless" } },
    "tour": { "agent": "codex", "model": "gpt-5-codex", "effort": "low", "prompt": "…" },
    "defaultPreset": "correctness",
    "presets": [{ "id": "correctness", "label": "Correctness", "agent": "claude", "effort": "high", "prompt": "…" }]
  }
}
```

Every field is optional.

- `agents.<kind>.mode` is `headless` (the default) or `interactive`. A headless
  run is a child process with schema-constrained output: `codex exec --json
  --sandbox read-only`, or `claude -p --tools Read,Grep,Glob,Skill
  --setting-sources user --session-id <id>`. Each run keeps its conversation so an
  Ask can resume it (ADR 0013); neither CLI lists these where you resume
  conversations. Claude Review runs load only your user settings, never
  the reviewed Worktree's `.claude/settings*.json`, whose hooks and `env` would run
  whatever the tool limits say.
  Claude bills `-p` use separately from interactive use, which is why the mode is
  set per kind. An interactive run is a fresh, visible Agent of that kind in the
  Worktree's Workspace, named `🗺 Tour · <branch>` or `🔍 Review · <preset>`:
  - It launches in a new window of the Workspace session, never in an idle shell,
    with the same read-only restrictions added to that launch only. Codex gets
    `--sandbox read-only --ask-for-approval never`. Claude gets `--tools
    Read,Grep,Glob,Skill --strict-mcp-config --setting-sources user` and keeps the
    console's hooks settings.
    The run's `model` and `effort` are added too. Operator `adapters.<kind>.args`
    still apply, except the flags these replace or that would loosen them (for
    example `--sandbox`, `--model` or Codex's
    `--dangerously-bypass-approvals-and-sandbox`).
  - The prompt ends by asking for one JSON object as the final message. A prompt
    too long to paste is written to a private file under
    `/tmp/remote-agent-console-<uid>/review-runs/`, and the agent is asked to read
    it. That is why interactive runs are unavailable under the Docker host bridge.
  - The console reads the reply from the agent's own transcript (Codex's rollout,
    Claude's session JSONL). A reply that fails validation gets one correction
    prompt in the same conversation.
  - The pane closes when the run succeeds or is cancelled. It stays open when the
    agent asks a question (the run keeps waiting, and the operator answers in the
    pane), when the run times out, and when the reply fails validation twice. A
    pane left open behaves as an ordinary Agent from then on.
- **Ask reviewer** on a Finding in a guided review asks the Code review's own
  conversation a question, in that kind's mode (ADR 0013). Headless, it resumes the
  conversation (`claude -p --resume <id>`, `codex exec resume <id>` with
  `-c sandbox_mode="read-only"`). Interactive, it relaunches the conversation with the
  agent's own resume (`claude --resume <id>`, `codex resume <id>`) and the same
  read-only restrictions, in a pane labelled `💬 Ask · <preset>`. That pane is kept
  for follow-up questions and closes after 15 idle minutes, or when the tour is
  dismissed or regenerated. Threads are stored with the tour and cleared with it.
  - A question notifies as usual, but a finished run does not, because the
    tour's ready state covers it. A run never takes focus. The tour and review
    job polls name the run's Agent (`run: { agentId, needsInput }`) so the browser
    can open its pane.
  - The run's timeout counts from when the prompt is delivered.
  - A kind that is not configured or whose program is not executable reports its
    Review runs unavailable.
- `tour` names the agent, `model`, `effort` and `prompt` that narrate the tour.
  The agent defaults to `codex` when `adapters.codex` is configured, else
  `claude`; with neither the tour reports unavailable. Without a `prompt` the
  console uses its built-in narration guidance. The browser may pick another of
  the agent's effort levels for one tour.
- `presets` (≤20) are the Code review's **Review presets**: `{ id, label, agent,
  model?, effort?, prompt }`, with `id` 1–40 letters, digits, `_` or `-`, `label`
  ≤80 characters. With no presets, one built-in **Correctness** preset (bugs,
  regressions, edge cases and security, not style) runs on the tour's agent.
  `defaultPreset` defaults to the first preset.
- `effort` must be one of the agent's levels: Codex accepts `minimal`, `low`,
  `medium`, `high`, `xhigh` (passed as `-c model_reasoning_effort=…`); Claude
  accepts `low`, `medium`, `high`, `xhigh`, `max` (`--effort`). Without one the
  CLI's own default applies. `model` is passed as `-m` / `--model`.
- A `prompt` (≤8000 characters) says what to look for. The console always
  appends the change list, the output shape and the rules its parser enforces,
  so a custom prompt cannot break the result. A Claude run may invoke the
  operator's skills (user `~/.claude/skills` and the Worktree's project
  `.claude/skills`), so a prompt can name one ("follow the security-review
  skill"). Edit, Write, Bash and MCP stay off, so only a skill that reads works;
  one that runs a command or edits fails at that step.

A tour or preset naming an agent that is not configured under `adapters`, an
effort that agent does not accept, a duplicate preset id or an unknown
`defaultPreset` fails config validation. A Review run never modifies the
Worktree.

A Code review runs only with a tour, on the same Comparison: started beside a
new tour, or added to the current stored tour. Each Worktree has one Code
review job at a time; a newer one, a new tour or dismissing the tour replaces
it. A run times out after 15 minutes. Its Findings (≤100 anchored to hunk
lines, plus general ones) are stored beside the tours in
`<RAC_REVIEW_TOURS_FILE without .json>.code-reviews.json` (by default
`.data/review-tours.code-reviews.json`) and shown with the tour that has the
same branch and Comparison fingerprint.

## Projects

A **Project** is a git repository the console manages. Configure each one once
under `projects`; its **Worktrees** are discovered from `git worktree list` and
are never declared, so a checkout created in a terminal appears on the dashboard
within a tick — no config edit or restart.

A repository does not need to be configured to work in it. When an agent or
Console shell runs in an unconfigured git checkout (one started by hand in
tmux, for example), the console treats the repository as an **implicit
Project** and the checkout gets a tab as one of its Worktrees, with the Code
panel, review tour, conversations and branch flyout. An implicit Project has no
stack commands, preview or Project buttons, and is not listed in the launcher.
It lasts while a tmux session runs in one of its Worktrees or one of them is
pinned; its Main worktree starts unpinned. It cannot be a Schedule target and
is left out of branch cleanup. To give it commands or a preview,
add a `projects[]` entry with its `path` and no `id`: the derived id matches, so
its notes and pins carry over. A session already marked as a Scratch Place keeps
that mark. See ADR 0014.

```json
{
  "projects": [
    {
      "id": "example",
      "label": "Example",
      "defaultBranch": "main",
      "path": "/home/me/code/example",
      "worktreesDirectory": "../example-worktrees",
      "commands": { "setup": "pnpm install", "start": "docker compose up -d", "status": "test -n running" },
      "newTask": "detach && new {taskId}",
      "push": { "label": "Finish and PR", "prompt": "$finish" },
      "port": 3000,
      "hostname": "app.example.com"
    }
  ]
}
```

- `id` — `[A-Za-z0-9_-]{1,80}`, the key for Project-wide state (`agent` and
  `scratch` are reserved). Optional: when omitted, the id is derived from the
  repository (the Main worktree's folder name and a short hash), the same id the
  repository has as an implicit Project, so its notes and pins carry over. A
  Project with no `id` whose `path` is missing is skipped with a boot warning.
  `label` defaults to `id`, or to the folder name when `id` is omitted.
- `path` — **any checkout of the repository** (a Linked worktree or a bare
  repository included). Its identity is the realpath of the common git
  directory, so two Projects pointing at the same repository are refused as
  duplicates. A `path` that is missing or not a git checkout at boot loads the
  Project as unavailable with a boot warning rather than stopping the server.
- `worktreesDirectory` — where the console will create new Worktrees; the
  default is a `../<basename>-worktrees` sibling of the Main worktree, and a
  relative path resolves against it. Absolute paths are allowed.
- `defaultBranch` — optional fallback branch for the branch flyout's **All PR**
  comparison, shared by the Code panel and commit list. The comparison uses the
  current branch's `branch.<name>.gh-merge-base` first, then the PR's base,
  the source branch recorded in Git's reflog, this configured branch, and finally
  `main`. Missing or unresolvable bases fall through in that order. Operational
  Git failures stop fallback to lower-priority branches. Remote refs and
  local-only branches are supported.
- `worktreeOrder` — optional checkout paths in display order, for example
  `[".", "../review", "../research"]`. Relative paths resolve against the
  configured Project `path`; symlinks resolve to the checkout's real path.
  Listed checkouts appear first in launch rows and tabs, independent of labels
  or branches. Missing paths are ignored. Unlisted checkouts retain the default
  Main-first, branch-name order, with detached checkouts last.
- `commands` (`start`/`stop`/`build`/`restart`/`migrate`/`status`/`setup`/`processes`) provides
  default stack commands; `newTask` and `push` are Project-wide. `newTask` adds a **New Task** action, uses
  `{taskId}` for an 8-character URL-safe random ID, and is enabled only when the
  Worktree is clean and fully pushed. `push` overrides the default
  **Commit/Push** action (which queues `review, commit, and push`).
  A `newTask` command can set `branch.<new-branch>.gh-merge-base` after creating
  the branch to keep its comparison and GitHub CLI pull-request target aligned;
  creating a branch with `--no-track` does not set that preference.
- `commands.setup` runs **once, when the console creates a Worktree**, in the new
  checkout and before any agent launches — the place to install dependencies or
  link secrets so a fresh checkout can build (for example `pnpm install`). It runs
  to completion; a non-zero exit reports a setup error and skips the agent launch
  (the Worktree still stands with its idle shell) rather than starting an agent
  into a half-prepared checkout. A successful run leaves nothing behind; a failed
  run keeps its combined output under `.data/stack-logs` (its path is logged) for
  inspection. Like the other `commands` it is operator-trust shell, so it is never
  surfaced to the browser.
- `commands.processes` declares one or more **Stack processes**: foreground
  commands that run until they are killed, such as
  `{ "api": "pnpm --filter api dev", "web": "pnpm --filter web dev" }`, for a
  stack with no daemon to hand off to. A process may instead be written
  `{ "command": "pnpm --filter api dev", "dependsOn": ["sync"] }`, naming the
  processes of the same map it needs started first; the string form is
  shorthand for `{ "command": … }`. Config validation refuses a `dependsOn`
  naming an undeclared process, the process itself, or a cycle. The stack
  menu's Start runs each in the background, dependencies first and otherwise
  in the order written, as a window named for the process in the
  Worktree's Workspace session (the tmux session holding its Agents and
  Terminals, created the way a launch creates one when there is none yet), with
  the same socket, login shell, host `PATH`, and Worktree root as the other
  `commands`; a process already running is left alone. The stack badge reads
  running, stopped, "`n` of `m` running", or exited (naming each process that
  exited, with its code) straight from those windows — no `status` command.
  Stop stops the processes in the reverse of that start order, dependants
  first: each is sent Ctrl+C, given up to
  about 10 seconds to exit, then its window is closed either way (a window that
  is the last in its session takes that session with it); Restart stops them
  all the same way, keeping their windows, and reruns each command in start
  order in its own pane, so a Terminal open on it stays attached. A step that
  fails ends the Start, Stop or Restart there and reports it failed; processes already
  started keep running. The stack menu lists the processes as rows, in the
  order written, each with its state; with several, clicking a row expands it
  (one at a time) to its notices, its own Start, Stop and Restart, what it
  needs and what needs it here, and what it uses elsewhere (below), and a lone
  process's row shows already expanded. A process's own actions act on it
  alone and leave the rest
  running, except that Start (and a Restart's rerun) first starts every process
  it transitively depends on that is not already running; a running dependency
  is left alone, and stopping a process leaves its dependants running (the MCP
  `run_stack_action` tool takes the same choice as an optional `process`).
  `dependsOn` orders starts only: nothing waits for a dependency to be ready, so
  a command that needs one to be listening checks for it itself. One action runs per
  Worktree at a time, whether it is on the whole stack or one process. Each
  process belongs to tmux, so it keeps running across a console restart and is found again by the tags on its window, and its pane
  scrolls back as far as that session's `history-limit`. A row's "Show
  output", and the menu's "Open Stack panel", open the **Stack panel**, a Panel
  beside the agent (and a ⋮ row on a phone) that lists the processes on its
  left and shows the selected one's actions, what it needs, what needs it and
  what it uses on its right, above that history, kept refreshing; while the
  process runs, its "Open as Terminal" opens its pane as a live Terminal panel, where
  dev-server hotkeys such as Vite's `r` work. Its header starts, stops and
  restarts the whole stack, and the browser remembers it open per Worktree.
  The pane is also in the Place's
  Terminal switcher, named for the process. A process's output is also
  written to `rac/processes/<name>.log` in the Worktree's own git directory
  (`.git/` for the Main worktree, `.git/worktrees/<id>/` for a Linked one), so
  an agent that reaches neither tmux nor the console reads it from its
  checkout: `cat "$(git rev-parse --git-path rac/processes/<name>.log)"`. The
  file is replaced with an empty one each time the process starts (a Start of
  a process already running leaves it alone), so it holds everything since
  then; it keeps the pane's raw bytes, terminal controls included, is never
  capped or rotated, is readable by the operator's user only, never shows in
  `git status`, and goes with a Linked worktree when that is removed. A
  symlink in its place is replaced, never written through. When the console
  cannot set the log up (git cannot name the git directory, or `rac/processes`
  cannot be made or is a symlink), the process still starts without it and the
  console logs why; a file the host cannot create goes unreported.
  A process can report **Process notices** to the console: every Start
  exports `RAC_PROCESS_NOTICES`, the host path of
  `rac/processes/<name>.notices.json` beside the log, after removing that
  file, and a Stop removes it too, so a notice lasts until the process next
  starts or stops. The process writes a JSON array to it:
  `[{ "level": "warning", "message": "static is not running", "worktree": "/code/static", "process": "static" }]`.
  `level` is `warning` (the default) or `info`; `message` is plain text of at
  most 500 characters; `worktree` (optional) is the absolute path of a
  checkout of any configured Project, and `process` (optional, needs
  `worktree`) a Stack process that checkout declares. The notices show in the
  process's part of the stack menu, and a `warning` puts a marker on the stack
  badge whose tooltip lists them. A notice naming a declared process hides
  while that process runs and shows again when it stops or exits. A notice
  naming a checkout offers **Open**, which switches to that Worktree (in a
  new tab if it has none) with its stack menu open, and one naming a declared
  process that is not running offers **Start**, which sends that Worktree's
  own Start for the process (starting its `dependsOn` too) while the current
  menu stays open. Only the
  operator's click starts it; the console never does on its own. The console
  rereads the file only when it changes; a file over 64 KB, not valid JSON,
  or not matching that shape is ignored whole and logged, and only the first
  20 notices are read. One-shot commands get no notices file. An agent in the
  checkout can write that file as well as the process can, so a notice is
  plain text the console shows, never markup, and is only as trustworthy as
  whatever can write the Worktree's git directory.
  A process can also report the processes it **uses** in other Worktrees:
  every Start exports `RAC_PROCESS_USES`, the host path of
  `rac/processes/<name>.uses.json`, after removing that file, but a Stop
  leaves it, so a stopped process still shows what it used last time. The
  process writes a JSON array to it:
  `[{ "worktree": "/code/static", "process": "static" }]`, where `worktree` is
  the absolute path (at most 4096 characters) of a checkout of any configured
  Project and `process` a Stack process that checkout declares, named as the
  config names one; the file is read, and refused, as the notices file is. Each one shows, labelled `<Project> / <Worktree>`, with its
  live state there, under its user's row and in an "Other worktrees" row of
  its own, which lists what uses each and counts those that are down, and the
  Stack panel lists them too, with each one's output read from its own
  Worktree. A used process counts as **down** only when it is not running and
  a process here that uses it is running or starting; then its user's row,
  the Other worktrees row and the stack badge warn. Start, Stop and Open on a
  used process act on its own Worktree (Open switches to it, with its stack
  menu open; a refused Start or Stop says why), and only on the operator's click: stopping a used process stops
  nothing here, and the console never starts or stops one on its own. One
  whose checkout the console does not know, or that its Worktree does not
  declare, shows by its path alone, with nothing to act on. A tool that
  reports uses has no need of "is not running" notices, which the down rule
  covers.
  "Show last command output" is the
  latest `build` or `migrate` run. Remove stops every running process before it
  removes the checkout, and its confirmation lists them. A process name is
  letters, digits, `_` and `-`, and the map holds up to 20 processes. The
  processes derive the `start`, `stop`, and `restart` actions, so `processes`
  cannot sit beside `start`, `stop`, `restart`, or `status`; `build`,
  `migrate`, and `setup` stay available beside them. There is no separate
  working-directory setting: to run from a subdirectory, write
  `{ "dev": "cd web && pnpm dev" }`. [Writing a stack helper](stack-helpers.md)
  sets out what these commands are given and what the console expects of them,
  for a program that runs a stack on the console's behalf.
- Preview configuration selects one of two mutually exclusive modes. `port` +
  `hostname` (both or neither) provide `https://<hostname>` proxied to
  `127.0.0.1:<port>`. Alternatively, `externalUrl` names an existing canonical
  HTTPS origin such as `https://app.example.com`; Remote Agents opens or embeds
  that origin directly and does not proxy it. Omit all three fields for no
  preview. Direct previews require the external site to permit framing; their
  mobile control changes viewport size only, without user-agent emulation.
  Proxied previews request fresh responses and send `Cache-Control: no-store`
  for pages, assets, API responses, redirects, and errors. This also
  applies when the proxied preview is opened in its own tab. It does not purge
  existing browser cache entries or change application service-worker caches;
  direct external previews retain the external site's cache policy.
- `worktreeOverrides` — optional runtime settings for individual discovered
  checkouts. Each entry's `path` resolves relative to the configured Project
  `path` (or may be absolute); symlinks resolve to the checkout's real path.
  Duplicate resolved selectors are rejected. Entries do not create or discover
  checkouts and do not change Project grouping, labels, or saved state.
  Omitted fields inherit the Project defaults. `commands` replaces the **entire**
  command set rather than merging actions, so UI-only worktrees do not inherit
  full-stack migration commands. Use `commands: {}` for no stack controls.
  With no preview fields, an override inherits the entire Project preview mode.
  Set `externalUrl` to an HTTPS origin to replace it with a direct preview, or
  set `hostname` and `port` to replace it with a proxied preview. Set
  `externalUrl` to `null`, or both `hostname` and `port` to `null`, to disable
  it. Direct and proxied fields cannot be mixed. Commands still run in the
  selected worktree's own directory.

### Temporary previews

Agents can share short-lived static pages and downloads without exposing a host
port or changing the Cloudflare Tunnel. Start the temporary server on loopback,
then register its port from the Remote Agents checkout:

```bash
python3 -m http.server 8899 --bind 127.0.0.1 --directory /tmp/result
pnpm preview:share 8899 --ttl 4h
```

The helper verifies that the loopback listener is live, writes a private
registration under `<RAC_TEMP_PREVIEWS_DIR ?? .data/temp-previews>`, and prints
an expiring URL under the configured `publicOrigin`. The viewer must already be
signed in to Remote Agents. Preview content receives a sandboxed browser origin,
and RAC session cookies, authorization headers, CSRF tokens, and upstream
cookies are not exposed to the temporary server.

Temporary previews are path-prefixed. Use relative links and asset URLs in
generated HTML. They are intended for static review artifacts and downloads,
not development servers that require root-relative assets or WebSockets. The
default lifetime is four hours; `--ttl` accepts minutes, hours, or days up to
seven days, such as `30m`, `4h`, or `1d`.

For example, add these entries to a Project to give a sibling checkout an
independent UI stack, run another as a foreground dev server, and keep a
research checkout stack-free:

```json
{
  "worktreeOverrides": [
    {
      "path": "../example-feature",
      "hostname": "feature.example.com",
      "port": 4000,
      "commands": {
        "start": "docker compose up -d ui",
        "stop": "docker compose stop ui",
        "status": "test -n \"$(docker compose ps --status running --services ui)\""
      }
    },
    { "path": "../example-web", "commands": { "processes": { "dev": "cd web && pnpm dev" } } },
    { "path": "../example-research", "hostname": null, "port": null, "commands": {} }
  ]
}
```

The `../example-web` entry swaps the Project's commands for a Stack process run
from the checkout's `web` subdirectory — replacing `commands` replaces
`processes` too.

The legacy `worktrees[]` migration preserves differing stack settings in these
overrides. Already-migrated installations can restore them from the saved
`.pre-projects.bak` configuration without rerunning the data migration. Keep
installation-specific hostnames and commands in the ignored local configuration.

The console launches an agent in a Worktree by Adapter kind (see
[Adapters](#adapters)); a Project never names a program. Every `git worktree
list` checkout appears automatically: the Main worktree is git's first entry, a
bare entry is never a Worktree, a Stale (git-prunable) checkout is hidden, a
git-locked one is flagged, and a detached HEAD is labelled by its short SHA.
Use **Rename worktree** from a launch row or agent menu to replace that generated
Project/branch label with a stable operator name such as `Dave`. The alias is
stored in `.data/worktrees.json` under the console's own checkout
(`RAC_SERVER_CHECKOUT`, `/workspace` in Docker), follows the worktree path across
launches, and does not rename the branch or directory. Set `RAC_WORKTREES_FILE`
to keep using an existing file stored elsewhere. **Use branch name** clears the
alias and restores the generated label.

### Creating Worktrees

The `+` launcher lists one section per Project. Each header carries a **New worktree…** control that opens a dialog with three sources:

- **New branch** — a branch name plus a base picked from the Project's branches, pre-selected to its default branch (`origin/HEAD` when the remote publishes one, else the checkout's current branch). A branch another Worktree already holds is still offered here — the default branch usually is one. The console creates the branch with `git worktree add --no-track -b <name> <path> <base>`.
- **Existing branch** — the same picker over the branches that can still be checked out: local branches checked out nowhere plus remote-only branches (marked); git creates the tracking branch for the latter.
- **Pull request** — the Project's open pull requests, yours first and others' folded below, shown when the Project has a GitHub origin. A pull request a Worktree already holds offers only a link to that Worktree. The dialog sends only the number; the server resolves the pull request from its own list, fetches its head into a pinned ref, and refuses it if the head changed on GitHub since it was listed (reopen the dialog and try again).

The git flyout's **PRs** and **Branches** rows also carry a **New worktree** action beside **Checkout**. It opens the same dialog with that pull request or branch preselected, and works while the current Worktree has uncommitted changes, when **Checkout** is disabled. It is offered wherever the launcher offers **New worktree…**.

A branch's checkout is created under the Project's `worktreesDirectory` at a leaf named for the branch (`/` flattened to `-`); you never type a path. A pull request's checkout is always named `pr-<number>`, and its label reads `<Project> · pr-<number>` whatever branch it holds. A pull request whose head branch lives on origin is checked out on that branch, tracking `origin/<branch>`. A fork pull request's head lives in another repository, so it is checked out on a console-owned branch, `rac/pr/<number>/<first 12 of its head SHA>`, with no upstream. A pull request counts as held by its `pr-<number>` Worktree and, for a fork, by any checkout of an earlier `rac/pr/<number>/…` head.

The console pins the new Worktree so it keeps its tab, runs the Project's [`commands.setup`](#projects) (when configured) to prepare the checkout, then opens what you chose under **Open** (the dialog remembers the last choice per Project):

- **Agent** (the default) — an idle shell plus the Project's last-used kind.
- **Review** — an Agent as above, then the guided review start sheet for it.
- **Terminal** — the idle shell only.
- **Nothing** — no shell or agent; the pin keeps its tab.

Setup runs in every mode, to completion, before anything opens, and gates the agent: the dialog shows that it is preparing the Worktree while it runs, and a setup failure under Agent or Review leaves the Worktree with its idle shell but launches no agent. The Worktree is created even if setup or the launch fails; the error is reported and the tab stands. Refusals (an existing branch name, an unresolvable base, a branch already checked out elsewhere, a pull request that is held, closed, or changed, or a target path that exists) are reported before git creates the checkout.

**Fork pull requests run no setup and no agent.** Their code comes from outside the repository, so a Worktree created from one opens only **Terminal** or **Nothing**, and setup never runs in it. The dialog marks fork pull requests **Fork** (as the git flyout does), disables Agent and Review when one is selected, and falls back to Terminal; the server enforces this itself from the resolved pull request and refuses an Agent or Review request with a 409. Checking a fork pull request out into the current Worktree from the git flyout is not affected: an Agent already running there keeps running, now in the fork's code.

### Removing Worktrees

**Remove** appears on an idle Worktree's power menu and beside its launcher row.
It is hidden on the Main worktree and disabled on a git-locked one. It is refused
(a clear message, never a forced removal) while an Agent or a stack command runs
in that Worktree. The dialog shows fresh facts read at that moment — the number
of uncommitted changes, whether the branch is pushed and merged, and how far it
is ahead of or behind its upstream:

- A tree with uncommitted changes can only be removed after you tick **Discard
  uncommitted changes**; git is then run with `--force` (never `-f -f`). An
  unpushed branch is only a warning, never a block.
- **Also delete branch `<name>`** is off by default and absent on a detached
  HEAD. When the branch is neither pushed nor merged the dialog warns that
  deleting it discards its commits for good, but the tick stays yours to make.
  It force-deletes the branch after the checkout is removed; if that delete
  fails, the removal still stands and the failure is reported.

A Worktree whose pull request has merged or closed shows a **PR merged · Remove** or **PR closed · Remove** chip on its launcher row, read from GitHub each time the launcher opens. It only opens the Remove dialog above, with all its safeguards. The checkout's branch must still be checked out there and sit at the pull request's final head, or behind it (as when the author pushed more commits after the Worktree was created); a lookup failure offers nothing. For a fork pull request's `rac/pr/<number>/…` branch, the Remove dialog counts commits the fetched `refs/rac/pull/<number>` contains as pushed, since GitHub holds them.

Removing a Worktree kills its idle shell, removes the checkout, and deletes its
console records (pin, last-used kind, review tour). It never
touches the Project-scoped notes and console-named conversations its siblings
share.

The active agent's **More → Branches** list also offers **Delete**. Its confirm
reloads the same safety facts before deletion: a checked-out branch is blocked
(and reports any uncommitted changes), while a branch that is neither pushed nor
merged requires **Delete unpushed work**. The hourly Cleanup list includes inactive
local branches whose PRs were merged or closed without merging. It also recognizes
Git ancestry, squash/rebase merges, and PRs targeting release branches. Closed,
unmerged PR branches are labeled separately with a warning and start unchecked;
select one explicitly to discard its unmerged work. Unchecked items are dismissed.
PR-based cleanup requires the local tip to exactly match the merged or closed PR's
head and no open PR for that same repository and branch. New local commits,
checked-out branches, and the default branch remain protected. Cleanup rechecks
GitHub evidence and local branch state before deleting; lookup failures never
authorize deletion, and a merged selection cannot silently become permission to
discard closed, unmerged work. GitHub authentication uses the same token as PR
discovery. Closed PR evidence alone never counts as merged in the manual
branch-deletion dialog.

### Pruning stale Worktrees

A checkout whose directory is gone (git calls it *prunable*) is hidden rather
than shown, and a console record left behind by a checkout git no longer lists is
kept, never deleted on its own. When either exists, the Project header shows
**N stale · Prune**. Prune is explicit and per Project: it runs `git worktree
prune` and deletes the orphaned console records, listing every stale path in the
confirm first. Under the Docker bridge a host checkout the container does not
mount can *look* stale from inside the container — the confirm warns you, so
prune only what you know is truly gone.

### Shared conversations and notes

Console-named conversations and sticky notes belong to the
**Project** and are shared automatically across all of its Worktrees, so related
checkouts see the same named Conversations and use the same notes with no
configuration. Queued prompts and prompt history belong to the agent they were
sent to; when an agent exits, its queued prompts are saved as notes. Scratch
agents derive their own persistence group from the scratch workspace, so scratch
agents opened in the same directory share entries across restarts; resuming a
Conversation requires a configured Project (scratch agents can name and list
their Conversations but cannot resume them).

Open a note's **More note actions** menu and enable **Show in all workspaces**
to make that same note available across Projects and Scratch. Edits, attachments,
and deletion affect the original note everywhere; sharing does not copy the note
or change its Schedule's target. Turn the option off to keep the note only in its
original Project or Scratch group. Doing so from another Workspace closes it
there after saving any draft. Shared notes, including empty ones, are retained
when closed.

Use the lock button beside **Delete** in a note's header to protect it from
deletion. Its icon is open when unlocked and closed when locked.
Locked notes hide the header's delete button and show a disabled lock
in place of Delete in the sticky flyout. Open the note and unlock it before
deleting it. Locking does not prevent editing, renaming, attachments, or running
the note; even an empty locked note is retained when closed. Protection is saved
with the note and enforced by the server.

Notes have no attachment-count limit; attachments may total 25 MB per note. Use
the paperclip beside **Send** (also beside existing attachments), drop files onto a note, or
paste an image into it. Click a filename to preview text or a PNG, JPEG, GIF, or
WebP image. Text previews show the first 256 KB; image previews support files up
to 5 MB. Other binary files remain attached but cannot be previewed. Files are saved
independently of text autosave and remain attached when the note is sent,
queued, launched, or run on a schedule. Notes containing only attachments are
kept when closed. Ctrl/Cmd+S in the prompt composer saves both its text and files
as one note; queued prompts saved as notes also retain their files. The notes
store allows 100 MB of attachment data across all projects and scratch groups.
Notes and queued prompts each also have a 200 MB serialized attachment budget,
including filenames and encoded file data.

Saved prompts have been retired in favour of Notes. On the first boot after
upgrading, any saved prompts are carried into Notes automatically and the source
file is renamed to a `*.migrated-to-notes.bak` sibling, so a second boot does
nothing; anything that could not be carried over is named in the boot log.
New migrations preserve valid attachments. Earlier migrations kept only their
filenames in note text; those backups remain untouched and are not replayed
automatically into notes that may since have been edited or deleted.

### Migrating project Push buttons

The first boot with a `projects[]` configuration adds root `buttons` defaults
and converts legacy `projects[].push` actions without changing their prompt
bytes. This stage rewrites only the application config and creates a private
`*.pre-buttons.bak` sibling. Existing backups are never overwritten; retain a
fresh private pre-update copy for rollback.

The updater accepts this known migration only when its boot evidence binds the
exact original and migrated config hashes and the live file still matches.
Concurrent config edits are refused. A crash after config replacement but before
boot evidence is published requires manual recovery. To roll back to an older
version, restore both compatible code and the fresh pre-update config before
restarting; older versions reject root `buttons`.

### Migrating from `worktrees[]`

Upgrading from a `worktrees[]` configuration is automatic: **start the console
once.** On the first boot it detects the legacy shape (a `worktrees` array, or a
`command`/`newAgentCommand`/`launch`/`resumeCommand` key) and, in one eager pass
driven by the config, rewrites the config to `projects[]` + `adapters.codex` and
re-keys every `.data` store to the Projects model (notes by Project; saved
prompts, queued prompts, history, review tours, pins and labels by Worktree). A
legacy `bookmarks.json` is retired on first boot instead of re-keyed — its
entries are logged once and the file set aside as `.retired` — because
Conversations replace bookmarks (ADR 0007). Distinct legacy `worktrees[]` labels
are preserved as Worktree aliases when several entries collapse into one Project.
Each rewritten file — the config included — gets a sibling `*.pre-projects.bak`
holding the original, so the change is revertable; an existing backup is never
overwritten. The boot log prints one report of what changed. A config already in
the new shape runs nothing and reads no data file, so the migration is a
one-time event.

Preview the plan before you restart with the dry run, which writes nothing:

```sh
pnpm config:check "$RAC_CONFIG"        # prints the migration plan for a legacy file
```

If the config lives somewhere the server cannot write at boot — a read-only
systemd or Docker deployment — run the migration once yourself, as a user who can
write it, then restart:

```sh
pnpm config:migrate "$RAC_CONFIG"      # migrates in place without booting
```

The migration **refuses to boot** with every problem listed and nothing written
when anything is ambiguous or unwritable — a bare program name that resolves to a
shell alias or is not on `PATH`, worktree entries that disagree on the launch
binary, a `launch` template placeholder, both `worktrees` and `projects` present,
a corrupt `.data` file, or a target the server cannot write. Fix an unwritable
target by mounting it read-write under Docker, by moving the config somewhere
writable and pointing `RAC_CONFIG` at it, or by running `pnpm config:migrate` as
above. To undo a
migration, restore each `*.pre-projects.bak` over its file and restart.

The default server listener is `127.0.0.1:8787`; `/healthz` is loopback-only and reveals only `{ "ok": true }`. Do not put passwords, prompts, session cookies, CSRF tokens, or WebSocket tickets in configuration or logs.

## Browser capabilities

### Managed preview permissions

Proxied Project previews opened in the console's Browser panel can request
location and foreground notifications through RAC. The preview must ask through
its usual `navigator.geolocation` or `Notification` APIs; RAC displays a consent
request identifying the preview origin before using the console's browser
permission. An existing browser grant to RAC does not automatically approve a
preview. The choices are **Allow once**, **allow always**, and **deny**.
Allow once covers only the current request. Allow always remembers approval for
that exact project origin and capability across reloads and future visits in
this RAC browser profile. Location and notification approvals are separate;
other origins do not inherit them. An ungranted choice may leave an inert
ordering token in browser storage; that token alone is neither approval nor
persistent denial. Browser storage must be available to save approval; a failed
save allows only the current request and displays an error.
If older approval cannot be cleared or verified, RAC stops the operation and
asks you to clear RAC site data instead.

Locations are returned only to the requesting preview. Notifications belong to
RAC's origin and identify the preview that requested them. Loading another
document, reloading, closing the Browser panel, or leaving the managed origin
stops active watches and attempts to close owned notifications, but remembered
approvals remain. **Reset preview permissions** in the Browser panel clears both
saved capabilities for that project origin, stops that panel's active resources,
and reloads its preview after confirmation because unsaved preview changes may
be lost. Choosing Allow once also clears any older remembered
approval for that capability. Deny blocks the capability for the current document
and clears older remembered approval. Later choices and resets supersede pending
native notification permission answers, including answers in other RAC tabs.
Superseded notification requests cannot gain permission or display a notification.
Reset and deny do not change RAC's native browser permissions.
The parent accepts requests only from that Browser panel's frame and configured
project origin. Only the direct managed frame opts into the permission shim;
nested project frames and ordinary non-RAC embeddings keep their native APIs.
The managed frame name is a compatibility marker, not permission authority.
Project code that changes `window.name` disables forwarding on later documents.

Direct external previews and sandboxed temporary previews do not receive this
bridge. Opening a preview in its own tab continues to use its native browser
permissions. The bridge does not share service-worker registrations, push
subscriptions, or background notification permissions with project apps, and it
does not change their native `navigator.permissions` results. Browser and device
support still apply; use HTTPS for remote access.

Notification forwarding supports bounded titles, bodies, tags, `silent`, and
`requireInteraction` options. Icons, actions, and app-controlled notification
data are not forwarded. A cancelled or timed-out broker request is an operation
error, not a permission decision.
When a mobile browser requires RAC's existing service worker to display a
notification, clicking it opens RAC instead of forwarding a click event to the
preview. Dismissed notices are reconciled on later notification requests.
Closing worker-backed notifications during revocation is best-effort: browser
API failures can leave a notification visible until it is dismissed.

The injected APIs provide compatibility forwarding, not a sandbox for a
project's own browser permissions. Project-controlled CSP or immutable browser
APIs can prevent forwarding; native permissions previously granted directly to
the project remain separate from RAC's grants. A saved notification approval
cannot override a revoked native notification permission: RAC asks for consent again
and requests native permission only from an explicit click. The child facade's
`Notification.permission` is restored asynchronously during its handshake and
may initially be `default` in the first project script task. Remembered approval
follows the origin if different project content later uses the same origin.

### Console alerts

The console can be installed as a browser app. Select **Enable alerts** in the
console to grant notification access; mobile browsers require that permission
request to come from a tap. Alerts cover agent questions and completed prompts,
completed guided reviews, cleanup targets, configured agent updates, and
Remote Agent Console commits waiting on `origin/main`. Agent-update alerts open
global settings; console-update alerts open the reviewed update screen. Voice input is
shown only in browsers that implement the Web Speech API; microphone access is
restricted by the console's permissions policy and is never required to use
the prompt field.

Agent questions, completed prompts, guided reviews, and cleanup targets are also
sent through server push, so they can arrive while the console is suspended.
Agent and Remote Agent Console update alerts depend on the browser's periodic
authenticated checks. For iOS, install the console to the Home Screen and use
iOS 16.4 or later before enabling alerts.

RAC automatically generates its Web Push (VAPID) signing keys on first startup.
The private key is stored with owner-only permissions in `push-vapid.json`,
next to `RAC_PUSH_SUBSCRIPTIONS_FILE` (by default `.data/push-subscriptions.json`).
Compose keeps both files in the mounted checkout's `.data` directory so restarts
and image rebuilds retain the same identity. Back up both files together; losing
the signing keys requires recreating browser push subscriptions. No external key
generator or account is required, and these keys are not configurable in Settings.
An existing complete `RAC_VAPID_PUBLIC_KEY` / `RAC_VAPID_PRIVATE_KEY` pair is
imported once to preserve subscriptions; after that the stored identity wins.
An invalid stored identity or incomplete legacy pair disables push rather than
silently replacing keys. Fix the stored file or legacy pair and retry.

If a worktree has a GitHub `origin` remote and the host has GitHub CLI
credentials (or `RAC_GITHUB_TOKEN`), the console can show a link to its open
pull request. The lookup is read-only and its result is cached briefly. The
same credentials let a guided review of an All PR tour post its notes and
comments to that pull request as your draft review (GitHub shows it as
Pending), which you then finish on GitHub; that needs a token allowed to write
pull request reviews, and the commented files must be committed and pushed.
See ADR 0011.

## Operational checks

Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build`. On a disposable Linux host, start Codex in tmux and confirm it appears; start an ordinary shell/HUD pane and confirm it does not. Verify the configured active worktree is not duplicated, prompt Tab/newline/Ctrl+Enter behavior, and explicitly confirm the session-scoped terminal warning before using terminal access.
