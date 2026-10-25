# Contributing

Remote Agent Console sits on a sensitive boundary: browser actions can become
terminal input and worktree commands. Keep changes focused, preserve the
single-operator security model, and include evidence for behavior changes.

## Local setup

```bash
pnpm install
cp config/remote-agent-console.example.json ~/remote-agent-console.json
cp .env.example .env
```

Follow [docs/setup.md](docs/setup.md) for required secrets and paths. The
browser app can be developed independently with `pnpm --filter @rac/web dev`;
API behavior requires the Linux/tmux environment described in the setup guide.

## Before opening a change

Run the smallest targeted tests while iterating, then the repository checks:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:scripts
pnpm build
```

For visible browser changes, add or update a Playwright spec in `apps/web/e2e`.
Install Chromium and run the browser suite separately:

```bash
pnpm --filter @rac/web exec playwright install --with-deps chromium
pnpm --filter @rac/web test:e2e
```

To exercise the editor's production page and worker security policies, build the
web app first, then run its browser tests against the preview server:

```bash
pnpm --filter @rac/web build
RAC_E2E_PRODUCTION_POLICY=1 pnpm --filter @rac/web test:e2e e2e/settings-code-editor.spec.ts
```

If the README presentation changes, regenerate its privacy-safe screenshots:

```bash
pnpm --filter @rac/web screenshots:readme
```

## Continuous integration

[Tests](.github/workflows/tests.yml) runs on every push to `main`, when a pull
request is opened, updated, or reopened, and on manual dispatch. GitHub-hosted
Ubuntu runners use Node 22 and the pnpm version pinned in `package.json`.

- Lint and typecheck cover both applications.
- Server tests install and probe tmux, with the shell and native-build tools
  needed to run the real-terminal suites instead of silently skipping them.
- Settings script tests run independently of the server suite. `pnpm test`
  alone does not include these tests or the browser tests.
- All Playwright specs run across eight isolated shards with one worker each.
  A separate job builds the web app and exercises the production-policy cases.
- Browser tests retry failures twice; reports retain flaky results, failure
  screenshots, and first-retry traces. Test reports are uploaded for seven days.

No application secrets, backend service, Docker daemon, or deployment is needed.
A failed job fails the workflow without cancelling the other browser shards.
New commits supersede earlier runs for the same PR; each `main` push keeps its
own run. Download the matching test-results artifact from the Actions run to
inspect a failure.

## Change expectations

- Keep diffs small and reuse existing utilities and interaction patterns.
- Add no dependency unless the change cannot reasonably use the current stack.
- Validate an agent target immediately before terminal input or destructive
  operations; never trust a stale pane identity.
- Bound persisted data, in-memory state, request bodies, and WebSocket frames.
- Keep secrets, prompt contents, session cookies, CSRF tokens, and tickets out
  of logs and test fixtures.
- Use synthetic names, paths, prompts, and output in screenshots.
- Update the relevant setup or Docker documentation when configuration changes.

## Pull requests

Explain the user-visible result, important security or lifecycle decisions, and
the commands used for validation. Include screenshots for UI changes when they
clarify responsive layout, interaction state, or accessibility behavior.
