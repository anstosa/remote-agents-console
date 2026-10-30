import { describe, expect, it } from 'vitest';
import { GithubService } from '../src/github/service.js';
import type { Command } from '../src/github/github.js';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

// control command completion in cache race tests
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// the module over one scripted `git remote get-url origin`; nothing here reaches GitHub
function cacheService(command: Command, now?: () => number): GithubService {
  return new GithubService({ command, request: async () => { throw new Error('GitHub must not be asked'); }, token: async () => undefined, ...(now === undefined ? {} : { now }) });
}

const octo = { owner: 'octo', name: 'repo' };

describe('a checkout\'s GitHub origin', () => {
  // hot dashboard reads must not spawn another remote lookup
  it('reuses one origin lookup across repeated reads', async () => {
    const commands: string[] = [];
    const service = cacheService(async (_file, args) => {
      commands.push(args[1] ?? '');
      return { code: 0, stdout: 'git@github.com:octo/repo.git\n' };
    });

    await expect(service.repositoryAt('/workspace')).resolves.toEqual(octo);
    await expect(service.repositoryAt('/workspace')).resolves.toEqual(octo);
    expect(commands).toEqual(['/workspace']);
  });

  it('coalesces concurrent origin lookups', async () => {
    const origin = deferred<{ code: number; stdout: string }>();
    let commands = 0;
    const service = cacheService(async () => {
      commands += 1;
      return await origin.promise;
    });

    const first = service.repositoryAt('/workspace');
    const second = service.repositoryAt('/workspace');
    await Promise.resolve();
    expect(commands).toBe(1);

    origin.resolve({ code: 0, stdout: 'git@github.com:octo/repo.git\n' });
    await expect(Promise.all([first, second])).resolves.toEqual([octo, octo]);
    expect(commands).toBe(1);
  });

  // external remote changes become visible within the bounded window
  it('expires positive, non-GitHub, and missing origin results', async () => {
    let now = 0;
    const origins = [
      { code: 0, stdout: 'git@github.com:octo/repo.git\n' },
      { code: 0, stdout: 'https://example.com/octo/repo.git\n' },
      { code: 2, stdout: '' },
      { code: 0, stdout: 'git@github.com:recovered/repo.git\n' }
    ];
    let commands = 0;
    const service = cacheService(async () => origins[commands++]!, () => now);

    await expect(service.repositoryAt('/workspace')).resolves.toEqual(octo);
    await service.repositoryAt('/workspace');
    expect(commands).toBe(1);

    now = 30_000;
    await expect(service.repositoryAt('/workspace')).resolves.toBeUndefined();
    await service.repositoryAt('/workspace');
    expect(commands).toBe(2);

    now = 60_000;
    await expect(service.repositoryAt('/workspace')).resolves.toBeUndefined();
    expect(commands).toBe(3);

    now = 90_000;
    await expect(service.repositoryAt('/workspace')).resolves.toEqual({ owner: 'recovered', name: 'repo' });
    expect(commands).toBe(4);
  });

  // slow subprocesses do not consume the completed-result cache window
  it('starts the origin TTL when discovery completes', async () => {
    const origin = deferred<{ code: number; stdout: string }>();
    let now = 0;
    let commands = 0;
    const service = cacheService(async () => {
      commands += 1;
      return commands === 1 ? await origin.promise : { code: 0, stdout: 'git@github.com:octo/repo.git\n' };
    }, () => now);

    const initial = service.repositoryAt('/workspace');
    now = 20_000;
    origin.resolve({ code: 0, stdout: 'git@github.com:octo/repo.git\n' });
    await initial;
    now = 49_999;
    await service.repositoryAt('/workspace');
    expect(commands).toBe(1);

    now = 50_000;
    await service.repositoryAt('/workspace');
    expect(commands).toBe(2);
  });

  // sibling checkouts must not borrow each other's origin result
  it('keeps origin entries isolated by workspace', async () => {
    const workspaces: string[] = [];
    const service = cacheService(async (_file, args) => {
      workspaces.push(args[1] ?? '');
      return { code: 0, stdout: 'git@github.com:octo/repo.git\n' };
    });

    await service.repositoryAt('/one');
    await service.repositoryAt('/two');
    await service.repositoryAt('/one');

    expect(workspaces).toEqual(['/one', '/two']);
  });

  // transient spawn failures must remain retryable
  it('retries a rejected origin command', async () => {
    let commands = 0;
    const service = cacheService(async () => {
      commands += 1;
      // fail only the initial lookup
      if (commands === 1) throw new Error('git unavailable');
      return { code: 0, stdout: 'git@github.com:octo/repo.git\n' };
    });

    await expect(service.repositoryAt('/workspace')).rejects.toThrow('git unavailable');
    await expect(service.repositoryAt('/workspace')).resolves.toEqual(octo);
    expect(commands).toBe(2);
  });

  // old checkout reads cannot repopulate the current generation
  it('does not let stale completion overwrite a post-invalidation origin', async () => {
    const firstOrigin = deferred<{ code: number; stdout: string }>();
    const secondOrigin = deferred<{ code: number; stdout: string }>();
    const origins = [firstOrigin, secondOrigin];
    let commands = 0;
    const service = cacheService(async () => await origins[commands++]!.promise);

    const stale = service.repositoryAt('/workspace');
    service.invalidateRepositories();
    const current = service.repositoryAt('/workspace');
    secondOrigin.resolve({ code: 0, stdout: 'git@github.com:new/repo.git\n' });
    await expect(current).resolves.toEqual({ owner: 'new', name: 'repo' });
    firstOrigin.resolve({ code: 0, stdout: 'git@github.com:old/repo.git\n' });
    await expect(stale).resolves.toEqual({ owner: 'old', name: 'repo' });

    await expect(service.repositoryAt('/workspace')).resolves.toEqual({ owner: 'new', name: 'repo' });
    expect(commands).toBe(2);
  });

  // old failures cannot evict a replacement lookup
  it('does not let stale rejection delete a post-invalidation origin', async () => {
    const firstOrigin = deferred<{ code: number; stdout: string }>();
    const secondOrigin = deferred<{ code: number; stdout: string }>();
    const origins = [firstOrigin, secondOrigin];
    let commands = 0;
    const service = cacheService(async () => await origins[commands++]!.promise);

    const stale = service.repositoryAt('/workspace');
    service.invalidateRepositories();
    const current = service.repositoryAt('/workspace');
    secondOrigin.resolve({ code: 0, stdout: 'git@github.com:new/repo.git\n' });
    await expect(current).resolves.toEqual({ owner: 'new', name: 'repo' });
    firstOrigin.reject(new Error('stale command failure'));
    await expect(stale).rejects.toThrow('stale command failure');

    await service.repositoryAt('/workspace');
    expect(commands).toBe(2);
  });

  // mutation revalidation and on-demand links check the live origin
  it('reads the live origin when asked for a fresh one', async () => {
    const origins = [
      'git@github.com:cached/repo.git\n',
      'https://example.com/unsupported/repo.git\n',
      'git@github.com:fresh/repo.git\n'
    ];
    let commands = 0;
    const service = cacheService(async () => ({ code: 0, stdout: origins[commands++]! }));

    await expect(service.repositoryAt('/workspace')).resolves.toEqual({ owner: 'cached', name: 'repo' });
    await expect(service.repositoryAt('/workspace', true)).resolves.toBeUndefined();
    await expect(service.repositoryAt('/workspace', true)).resolves.toEqual({ owner: 'fresh', name: 'repo' });
    expect(commands).toBe(3);
  });
});
