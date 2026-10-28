import { lstat, readFile, unlink } from 'node:fs/promises';
import { paneEnv } from '../tmux/command.js';
const descriptor = process.argv[2];
if (!descriptor || !descriptor.startsWith(`/tmp/remote-agent-console-${process.getuid?.() ?? 0}/`)) process.exitCode = 2;
else { try { const info = await lstat(descriptor); if (!info.isFile() || (info.mode & 0o077)) throw new Error('unsafe descriptor'); const { program, args, cwd } = JSON.parse(await readFile(descriptor, 'utf8')); await unlink(descriptor); if (typeof program !== 'string' || !program.startsWith('/') || !Array.isArray(args) || typeof cwd !== 'string') throw new Error('invalid descriptor'); process.chdir(cwd); process.execve!(program, [program, ...args], paneEnv()); } catch { process.exitCode = 2; } }
