import { describe, expect, it } from 'vitest';
import { omxAdapter } from '../../src/adapters/omx.js';
import { codexAdapter } from '../../src/adapters/codex.js';

const id = '0198c333-3333-7333-8333-333333333333';
// the probed OMX 0.21.0 wrapper: the mise bin shim execs node on the packaged CLI entry
const node = '/home/ubuntu/.local/share/mise/installs/node/24.18.1/bin/node';
const omxJs = '/home/ubuntu/.local/share/mise/installs/npm-oh-my-codex/v0.21.0/node_modules/.bin/../.mise/oh-my-codex@0.21.0/node_modules/oh-my-codex/dist/cli/omx.js';
const recognizes = (comm: string, argv: string[]) => omxAdapter.recognizes({ comm, argv });

describe('omx adapter launch', () => {
  it('owns --direct and places it before the mode arguments in every mode', () => {
    expect(omxAdapter.launch({ mode: 'fresh', cwd: '/w', sandboxed: false }).args).toEqual(['--direct']);
    expect(omxAdapter.launch({ mode: 'continue', cwd: '/w', sandboxed: false }).args).toEqual(['--direct', 'resume', '--last']);
    expect(omxAdapter.launch({ mode: 'resume', conversationId: id, cwd: '/w', sandboxed: false }).args).toEqual(['--direct', 'resume', id]);
  });

  it('falls back to a fresh launch when a resume carries no conversation id', () => {
    expect(omxAdapter.launch({ mode: 'resume', cwd: '/w', sandboxed: false }).args).toEqual(['--direct']);
  });

  it('reserves the tmux-policy flags so an operator copy is dropped at boot', () => {
    expect(omxAdapter.conflictingArgs).toEqual(['--direct', '--tmux']);
  });
});

describe('omx adapter recognizes', () => {
  it('claims the OMX wrapper launched bare or with resume', () => {
    expect(recognizes('MainThread', [node, omxJs, '--direct'])).toBe(true);
    expect(recognizes('MainThread', [node, omxJs, '--direct', 'resume', '--last'])).toBe(true);
    expect(recognizes('MainThread', ['node', '/home/ubuntu/n/bin/omx', 'resume', id])).toBe(true);
    expect(recognizes('omx', ['/home/ubuntu/bin/omx'])).toBe(true);
    expect(recognizes('omx', ['omx', 'launch'])).toBe(true);
    // node's own flags before the script do not hide the entry
    expect(recognizes('MainThread', ['node', '--enable-source-maps', omxJs, '--direct'])).toBe(true);
  });

  it('decides on the first argument alone, as OMX does: a leading --flag is the launch whatever follows', () => {
    // operator arguments that take a value (`adapters.omx.args`) sit after the console's `--direct`
    expect(recognizes('MainThread', [node, omxJs, '--direct', '-c', 'model_reasoning_effort=high'])).toBe(true);
    expect(recognizes('MainThread', [node, omxJs, '--direct', '--model', 'o3'])).toBe(true);
    expect(recognizes('omx', ['omx', '--direct', '--', '--model', 'o3'])).toBe(true);
    // OMX reads a bare single-dash or informational first argument as something other than a launch
    expect(recognizes('omx', ['omx', '-c', 'model_reasoning_effort=high'])).toBe(false);
    expect(recognizes('omx', ['omx', '--help'])).toBe(false);
    expect(recognizes('omx', ['omx', '--version'])).toBe(false);
  });

  it('treats every other OMX subcommand as a helper, not an Agent', () => {
    for (const subcommand of [['hud', '--watch'], ['team', 'spawn', '3'], ['sidecar'], ['mcp-serve'], ['sparkshell'], ['exec', '--json'], ['update'], ['doctor']]) {
      expect(recognizes('MainThread', [node, omxJs, ...subcommand]), subcommand.join(' ')).toBe(false);
      expect(recognizes('omx', ['omx', ...subcommand]), subcommand.join(' ')).toBe(false);
    }
  });

  it('never claims Codex itself, the helper scripts OMX spawns, a node tool given a directory named omx, or a shell that mentions omx', () => {
    expect(recognizes('codex', ['codex', '-c', 'model_instructions_file="/repo/.omx/state/sessions/x/AGENTS.md"'])).toBe(false);
    expect(recognizes('MainThread', [node, '/opt/oh-my-codex/dist/scripts/notify-fallback-watcher.js', '--cwd', '/repo', '--parent-pid', '18'])).toBe(false);
    // the entry is the script node runs, never a later argument that happens to be called omx
    expect(recognizes('MainThread', [node, '/opt/oh-my-codex/dist/scripts/notify-fallback-watcher.js', '--cwd', '/home/ubuntu/code/omx', '--parent-pid', '18'])).toBe(false);
    expect(recognizes('MainThread', ['node', '/opt/tool/build.js', '--out', '/srv/omx'])).toBe(false);
    expect(recognizes('sh', ['sh', '-c', 'omx --direct'])).toBe(false);
    expect(recognizes('MainThread', ['node', '/app/server.js'])).toBe(false);
  });
});

describe('omx adapter shares the Codex TUI behaviour', () => {
  // share the exact native lifecycle parser rather than drifting between adapters
  it('reuses the Codex submission, turns, commands, conversations, completion and managed lifecycle objects by reference', () => {
    expect(omxAdapter.submission).toBe(codexAdapter.submission);
    expect(omxAdapter.turns).toBe(codexAdapter.turns);
    expect(omxAdapter.commands).toBe(codexAdapter.commands);
    expect(omxAdapter.conversations).toBe(codexAdapter.conversations);
    expect(omxAdapter.completion).toBe(codexAdapter.completion);
    expect(codexAdapter.managedPromptLifecycleV1).toBeDefined();
    expect(omxAdapter.managedPromptLifecycleV1).toBe(codexAdapter.managedPromptLifecycleV1);
    expect(omxAdapter.questions?.parse).toBe(codexAdapter.questions?.parse);
    expect(omxAdapter.questions?.queued).toBe(codexAdapter.questions?.queued);
  });

  it('keeps the structured question files to OMX: plain Codex no longer reads them', () => {
    expect(omxAdapter.questions?.pending).toBeDefined();
    expect(codexAdapter.questions?.pending).toBeUndefined();
  });

  it('reads the Codex title rule', () => {
    expect(omxAdapter.inferState({ title: '⠋ Working' })).toBe('working');
    expect(omxAdapter.inferState({ title: 'action required' })).toBe('question');
    expect(omxAdapter.inferState({ title: 'Ready' })).toBe('finished');
  });
});
