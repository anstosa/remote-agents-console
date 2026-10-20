import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectOpen } from '../src/project-open.js';
import type { ProcessNotice, ProcessUse, StackAction, StackProcessState, StackSelection, StartableNoticeTarget } from '../src/stack-operations.js';

// render controls during an active operation
export const renderProjectOpen = (root: HTMLElement) => {
  createRoot(root).render(createElement(ProjectOpen, {
    url: 'https://project.example.com',
    stack: { actions: ['build', 'restart'], operation: 'build', tunnel: true },
    onBrowserToggle: () => {},
    onStackAction: () => {}
  }));
};

// render stateful managed project controls
const ManagedProjectOpenControls = () => {
  const [browserOpen, setBrowserOpen] = useState(false);
  return createElement(ProjectOpen, {
    url: 'https://project.example.com',
    stack: { actions: ['start', 'build', 'restart'], running: true, tunnel: false },
    browserOpen,
    onBrowserToggle: () => setBrowserOpen(open => !open),
    onStackAction: async () => {
      // preserve visible progress for assertions
      await new Promise(resolve => window.setTimeout(resolve, 200));
    }
  });
};

export const renderProjectOpenControls = (root: HTMLElement) => {
  createRoot(root).render(createElement(ManagedProjectOpenControls));
};

export const renderStoppedProjectOpenControls = (root: HTMLElement) => {
  createRoot(root).render(createElement(ProjectOpen, {
    url: 'https://project.example.com',
    stack: { actions: ['start', 'build'], running: false, tunnel: false },
    onBrowserToggle: () => {},
    onStackAction: () => {}
  }));
};

// render stateful direct project controls
const DirectProjectOpenControls = () => {
  const [browserOpen, setBrowserOpen] = useState(false);
  return createElement(ProjectOpen, {
    url: 'https://external-preview.example/map/',
    stack: { actions: [], tunnel: true },
    browserOpen,
    onBrowserToggle: () => setBrowserOpen(open => !open)
  });
};

// render an available direct project without stack commands
export const renderDirectProjectOpenControls = (root: HTMLElement) => {
  createRoot(root).render(createElement(DirectProjectOpenControls));
};

// render a direct project with explicit failed health
export const renderUnavailableDirectProjectOpenControls = (root: HTMLElement) => {
  createRoot(root).render(createElement(ProjectOpen, {
    url: 'https://external-preview.example/map/',
    stack: { actions: ['start'], running: false, tunnel: false },
    onBrowserToggle: () => {},
    onStackAction: () => {}
  }));
};

export const renderStackOnlyControls = (root: HTMLElement) => {
  createRoot(root).render(createElement(ProjectOpen, {
    stack: { actions: ['start', 'stop', 'build', 'restart'], running: true },
    onStackAction: () => {}
  }));
};

export const renderStackOnlyStatuses = (root: HTMLElement) => {
  // keep status fixtures static
  const ignoreStackAction = () => {};
  // render each stack-only status
  createRoot(root).render(createElement('div', {},
    createElement(ProjectOpen, { stack: { actions: ['start'], running: true }, onStackAction: ignoreStackAction }),
    createElement(ProjectOpen, { stack: { actions: ['start'], running: false }, onStackAction: ignoreStackAction }),
    createElement(ProjectOpen, { stack: { actions: ['start'] }, onStackAction: ignoreStackAction })
  ));
};

// render a Stack process that is still Starting (up, but its tunnel not yet healthy)
export const renderStartingProcessControls = (root: HTMLElement) => {
  const Controls = () => {
    const [operation, setOperation] = useState<'stop'>();
    return createElement(ProjectOpen, {
      stack: { actions: ['start', 'stop', 'restart'], running: true, transition: 'starting', ...(operation === undefined ? {} : { operation }) },
      onStackAction: async () => {
        setOperation('stop');
        // preserve visible progress for assertions
        await new Promise(resolve => window.setTimeout(resolve, 200));
      }
    });
  };
  createRoot(root).render(createElement(Controls));
};

// render a Stack process that died on its own: with its exit code and a down tunnel (exited wins),
// and after a signal, when tmux keeps no exit code
export const renderExitedProcessStatuses = (root: HTMLElement) => {
  const ignoreStackAction = () => {};
  createRoot(root).render(createElement('div', {},
    createElement(ProjectOpen, { stack: { actions: ['start', 'stop', 'restart'], running: false, tunnel: false, processes: [{ name: 'dev', state: 'exited', exitCode: 127 }] }, onStackAction: ignoreStackAction }),
    createElement(ProjectOpen, { stack: { actions: ['start', 'stop', 'restart'], running: false, processes: [{ name: 'dev', state: 'exited' }] }, onStackAction: ignoreStackAction })
  ));
};

// the Stack panel openings the menu asked for (`null` for one on no process), for a spec to read back
type OpenedPanels = { openedPanels?: (StackSelection | null)[] };
const recordOpenedPanel = (selection?: StackSelection) => {
  const record = window as unknown as OpenedPanels;
  record.openedPanels = [...record.openedPanels ?? [], selection ?? null];
};

// render a Stack process stopped on purpose, beside what its tunnel still says (a check from
// before the Stop, or one that now fails), and the tunnel-led states a stopped process must not
// take from the rest: a running process whose tunnel fails, and a daemon stack that is down
export const renderStoppedProcessStatuses = (root: HTMLElement) => {
  const ignoreStackAction = () => {};
  const processActions: StackAction[] = ['start', 'stop', 'restart'];
  createRoot(root).render(createElement('div', {},
    createElement(ProjectOpen, { stack: { actions: processActions, running: false, tunnel: true, processes: [{ name: 'dev', state: 'stopped' }] }, onStackAction: ignoreStackAction }),
    createElement(ProjectOpen, { stack: { actions: processActions, running: false, tunnel: false, processes: [{ name: 'dev', state: 'stopped' }] }, onStackAction: ignoreStackAction }),
    createElement(ProjectOpen, { stack: { actions: processActions, running: true, tunnel: false, processes: [{ name: 'dev', state: 'running' }] }, onStackAction: ignoreStackAction }),
    createElement(ProjectOpen, { stack: { actions: ['start', 'stop'], running: false, tunnel: false }, onStackAction: ignoreStackAction })
  ));
};

// render a Stack process Worktree that also has a one-shot `build`, whose last output the dialog shows
export const renderProcessOutputControls = (root: HTMLElement) => {
  createRoot(root).render(createElement(ProjectOpen, {
    title: 'Main',
    stack: { actions: ['start', 'stop', 'build', 'restart'], running: true, processes: [{ name: 'dev', state: 'running' }] },
    onStackAction: () => {},
    onProcessAction: () => {},
    onStackLog: async () => ({ action: 'build', active: false, startedAt: '2026-09-26T10:00:00.000Z', completedAt: '2026-09-26T10:01:00.000Z', output: 'built in 3s' }),
    onOpenStackPanel: recordOpenedPanel
  }));
};

// render a Stack process with no one-shot commands, which has died
export const renderExitedProcessOutputControls = (root: HTMLElement) => {
  createRoot(root).render(createElement(ProjectOpen, {
    stack: { actions: ['start', 'stop', 'restart'], running: false, processes: [{ name: 'dev', state: 'exited', exitCode: 127 }] },
    onStackAction: () => {},
    onStackLog: async () => undefined,
    onOpenStackPanel: recordOpenedPanel
  }));
};

// render a stack of several Stack processes: partly running with a healthy tunnel (the partial
// count wins), and with one crashed (exited wins, naming it). The first opens the Stack panel.
export const renderSeveralProcessStatuses = (root: HTMLElement) => {
  const processActions: StackAction[] = ['start', 'stop', 'restart'];
  createRoot(root).render(createElement('div', {},
    createElement(ProjectOpen, {
      stack: { actions: processActions, tunnel: true, processes: [{ name: 'sync', state: 'running' }, { name: 'api', state: 'stopped' }, { name: 'web', state: 'running' }] },
      onStackAction: () => {},
      onOpenStackPanel: recordOpenedPanel
    }),
    createElement(ProjectOpen, { stack: { actions: processActions, tunnel: false, processes: [{ name: 'sync', state: 'running' }, { name: 'api', state: 'exited', exitCode: 1 }, { name: 'web', state: 'exited', exitCode: 2 }] }, onStackAction: () => {} })
  ));
};

// the process actions the stack menu asked for, for a spec to read back
type ProcessActions = { processActions?: { name: string; action: StackAction }[]; releaseProcessAction?: () => void };

// hold process operations until the spec has observed their pending state
export const renderProcessSectionControls = (root: HTMLElement) => {
  // model independent process outcomes
  const Controls = () => {
    const [processes, setProcesses] = useState<StackProcessState[]>([{ name: 'sync', state: 'running' }, { name: 'api', state: 'running', dependsOn: ['sync'] }, { name: 'web', state: 'exited', exitCode: 1, dependsOn: ['api'] }, { name: 'docs', state: 'stopped' }]);
    return createElement(ProjectOpen, {
      title: 'testing',
      stack: { actions: ['start', 'stop', 'build', 'restart'], processes },
      onStackAction: () => {},
      onStackLog: async () => undefined,
      onOpenStackPanel: recordOpenedPanel,
      // record the action before waiting for its simulated response
      onProcessAction: async (name: string, action: StackAction) => {
        const record = window as unknown as ProcessActions;
        record.processActions = [...record.processActions ?? [], { name, action }];
        // let the spec settle the boundary without a timing race
        await new Promise<void>(resolve => { record.releaseProcessAction = resolve; });
        delete record.releaseProcessAction;
        // publish the process outcome
        setProcesses(current => current.map(process => process.name === name ? { name, state: action === 'stop' ? 'stopped' : 'running', ...(process.dependsOn === undefined ? {} : { dependsOn: process.dependsOn }) } : process));
      }
    });
  };
  createRoot(root).render(createElement(Controls));
};

// render stacks whose process has an action in flight from elsewhere (another tab, or MCP): one of
// several, and a lone process, which has no section of its own
export const renderProcessOperationControls = (root: HTMLElement) => {
  createRoot(root).render(createElement('div', {},
    createElement(ProjectOpen, {
      stack: { actions: ['start', 'stop', 'restart'], running: true, processes: [{ name: 'sync', state: 'running' }, { name: 'api', state: 'running', operation: 'restart' }] },
      onStackAction: () => {},
      onProcessAction: () => {}
    }),
    createElement(ProjectOpen, { stack: { actions: ['start', 'stop', 'restart'], running: true, processes: [{ name: 'dev', state: 'running', operation: 'stop' }] }, onStackAction: () => {}, onProcessAction: () => {} })
  ));
};

// render stacks whose processes reported Process notices: several processes, one carrying a
// warning that names another Worktree's process and an info notice, and a lone process whose
// only notice is info, which puts no warning on the badge
export const renderProcessNoticeControls = (root: HTMLElement) => {
  const processActions: StackAction[] = ['start', 'stop', 'restart'];
  createRoot(root).render(createElement('div', {},
    createElement(ProjectOpen, {
      stack: { actions: processActions, running: true, processes: [
        { name: 'api', state: 'running', notices: [
          { level: 'warning', message: 'static is not running (obsidian-static master)', target: { worktreeId: 'site:/code/static', label: 'Static · master', process: 'static', state: 'stopped' } },
          { level: 'info', message: 'using the cached schema' }
        ] },
        { name: 'web', state: 'running' }
      ] },
      onStackAction: () => {},
      onProcessAction: () => {}
    }),
    createElement(ProjectOpen, {
      stack: { actions: processActions, running: false, processes: [{ name: 'dev', state: 'exited', exitCode: 1, notices: [{ level: 'info', message: 'waiting for the database' }] }] },
      onStackAction: () => {}
    })
  ));
};

// render a Worktree whose processes use processes in other Worktrees: `api` runs and uses Static's
// `static`, which is stopped, and a `docs` the console could not place; `web` is stopped and uses
// `static` too, and Search's `search`, which runs; `worker` runs and uses Queue's `queue`, which has
// exited. Stopping `api` and starting `static` land in the next state, and `startWeb()` puts a Start
// in flight on `web`; every used process's Start or Stop, and every Open, is recorded.
type UseActions = { useActions?: string[]; openedWorktrees?: string[]; startWeb?: () => void };
export const renderUsesControls = (root: HTMLElement) => {
  const Controls = () => {
    const [apiState, setApiState] = useState<'running'|'stopped'>('running');
    const [staticState, setStaticState] = useState<'running'|'stopped'>('stopped');
    const [webStarting, setWebStarting] = useState(false);
    const record = window as unknown as UseActions;
    record.startWeb = () => setWebStarting(true);
    const staticUse: ProcessUse = { worktreeId: 'site:/code/static', label: 'Static Site / Main', process: 'static', state: staticState };
    const processes: StackProcessState[] = [
      { name: 'api', state: apiState, uses: [staticUse, { label: '/code/elsewhere', process: 'docs' }] },
      { name: 'web', state: 'stopped', ...(webStarting ? { operation: 'start' as const } : {}), dependsOn: ['api'], uses: [staticUse, { worktreeId: 'search:/code/search', label: 'Search / Main', process: 'search', state: 'running' }] },
      { name: 'worker', state: 'running', uses: [{ worktreeId: 'queue:/code/queue', label: 'Queue / Main', process: 'queue', state: 'exited', exitCode: 1 }] }
    ];
    return createElement(ProjectOpen, {
      worktreeId: 'app:/code/app',
      title: 'Main',
      stack: { actions: ['start', 'stop', 'restart'], processes },
      onStackAction: () => {},
      onProcessAction: async (name: string, action: StackAction) => { if (name === 'api') setApiState(action === 'stop' ? 'stopped' : 'running'); },
      onUseAction: async (worktreeId: string, process: string, action: 'start'|'stop'|'restart') => {
        record.useActions = [...record.useActions ?? [], `${action} ${worktreeId} ${process}`];
        await new Promise(resolve => window.setTimeout(resolve, 200));
        if (process === 'static') setStaticState(action === 'stop' ? 'stopped' : 'running');
      },
      onOpenWorktree: (worktreeId: string) => { record.openedWorktrees = [...record.openedWorktrees ?? [], worktreeId]; },
      onOpenStackPanel: recordOpenedPanel
    });
  };
  createRoot(root).render(createElement(Controls));
};

// what a notice's Open and Start asked for, the error the next Start fails with, and how a spec
// lets a successful Start land in the next state
type NoticeActions = { openedTargets?: string[]; noticeStarts?: string[]; noticeStartError?: string; releaseNoticeStart?: () => void };

// render the stack controls of two Worktrees, only one showing at a time as a tab does: App's
// `api` reports that Static's `static` is down, and the notice hides while `static` runs, as the
// console hides it, and another names App itself. A notice's Open shows Static with its stack
// menu requested; its Start is held briefly, fails with `noticeStartError` when a spec sets one,
// and otherwise returns, landing in the next state only when the spec calls `releaseNoticeStart`.
export const renderNoticeTargetControls = (root: HTMLElement) => {
  const processActions: StackAction[] = ['start', 'stop', 'restart'];
  const Controls = () => {
    const [shown, setShown] = useState<'app'|'static'>('app');
    const [staticState, setStaticState] = useState<'running'|'stopped'>('stopped');
    const record = window as unknown as NoticeActions;
    const staticTarget = { worktreeId: 'site:/code/static', label: 'Static · master' };
    const notices: ProcessNotice[] = [
      ...staticState === 'running' ? [] : [{ level: 'warning' as const, message: 'static is not running (obsidian-static master)', target: { ...staticTarget, process: 'static', state: staticState } }],
      { level: 'info', message: 'docs are stale', target: { ...staticTarget, process: 'docs' } },
      { level: 'info', message: 'using the cached schema' },
      { level: 'info', message: 'reloading the config', target: { worktreeId: 'app:/code/app', label: 'App · main' } }
    ];
    const onOpenWorktree = (worktreeId: string) => {
      record.openedTargets = [...record.openedTargets ?? [], worktreeId];
      setShown('static');
    };
    const onStartNoticeTarget = async (target: StartableNoticeTarget) => {
      record.noticeStarts = [...record.noticeStarts ?? [], `${target.worktreeId} ${target.process}`];
      await new Promise(resolve => window.setTimeout(resolve, 300));
      const error = record.noticeStartError;
      if (error !== undefined) { delete record.noticeStartError; throw new Error(error); }
      record.releaseNoticeStart = () => setStaticState('running');
    };
    return shown === 'app'
      ? createElement(ProjectOpen, { key: 'app', worktreeId: 'app:/code/app', stack: { actions: processActions, running: true, processes: [{ name: 'api', state: 'running', notices }, { name: 'web', state: 'running' }] }, onStackAction: () => {}, onProcessAction: () => {}, onOpenWorktree, onStartNoticeTarget })
      : createElement(ProjectOpen, { key: 'static', stack: { actions: processActions, running: staticState === 'running', processes: [{ name: 'static', state: staticState }] }, onStackAction: () => {}, menuRequested: true });
  };
  createRoot(root).render(createElement(Controls));
};
