import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { readRequest } from "./contracts.mjs";
import { stopAgents } from "./agent-stop.mjs";

// write one strict queue request fixture
function requestFile(request) {
  const root = mkdtempSync(resolve(tmpdir(), "rac-agent-stop-"));
  const path = resolve(root, `${request.id}.json`);
  writeFileSync(path, JSON.stringify(request));
  return { root, path };
}

test("Agent stop requests accept only bounded same-user lifetimes with a near deadline", () => {
  const valid = { version: 1, id: "agent_stop_request_0001", kind: "agents-stop", generation: 1, agentStop: { deadline: Date.now() + 5_000, targets: [{ pid: 123, startTime: "456", uid: 1200, kind: "codex" }] } };
  const descriptor = { generation: 1, uid: 1200 };
  const fixture = requestFile(valid);
  try {
    assert.deepEqual(readRequest(fixture.path, descriptor), valid);
    // arbitrary signals and commands are outside the strict envelope
    for (const changed of [
      { ...valid, signal: "SIGKILL" },
      { ...valid, agentStop: { ...valid.agentStop, deadline: Date.now() + 60_000 } },
      { ...valid, agentStop: { ...valid.agentStop, targets: [{ ...valid.agentStop.targets[0], uid: 1300 }] } },
      { ...valid, agentStop: { ...valid.agentStop, targets: [{ ...valid.agentStop.targets[0], command: "kill -9 1" }] } }
    ]) {
      writeFileSync(fixture.path, JSON.stringify(changed));
      assert.throws(() => readRequest(fixture.path, descriptor), { code: "invalid-request" });
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Agent stop dispatch calls only the fixed Python pidfd helper", async () => {
  const target = { pid: 123, startTime: "456", uid: 1200, kind: "claude" };
  const deadline = Date.now() + 5_000;
  const descriptor = { hostCheckout: "/repo" };
  const agentStopRunner = async (command, args, options) => {
    assert.equal(command, "/usr/bin/python3");
    assert.deepEqual(args.slice(0, 1), ["/repo/scripts/settings/terminate_agent.py"]);
    assert.deepEqual(JSON.parse(Buffer.from(args[1], "base64url").toString("utf8")), { deadline, targets: [target] });
    assert.deepEqual(options.env, { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" });
    return { code: 0, stdout: Buffer.from(JSON.stringify({ version: 1, results: [{ pid: 123, startTime: "456", status: "signal_sent" }] })), stderr: Buffer.alloc(0) };
  };

  await assert.doesNotReject(async () => {
    assert.deepEqual(await stopAgents(descriptor, { agentStop: { deadline, targets: [target] } }, { agentStopRunner }), { phase: "signal-sent", agentStops: [{ pid: 123, startTime: "456", status: "signal_sent" }] });
  });
});

test("the host helper rejects managed and nested worker modes in pure recognition checks", () => {
  const helper = resolve(import.meta.dirname, "terminate_agent.py");
  const source = [
    "import importlib.util, sys",
    "spec = importlib.util.spec_from_file_location('terminate_agent', sys.argv[1])",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "assert module.recognized_kind('codex', ['codex']) == 'codex'",
    "assert module.recognized_kind('codex', ['codex', 'app-server', '--listen', 'stdio://']) is None",
    "assert module.recognized_kind('MainThread', ['node', '/pkg/omx.js', 'team', '2']) is None",
    "assert module.recognized_kind('claude', ['claude', '--print', 'hello']) is None",
    "claude = '/opt/@anthropic-ai/claude-code/cli.js'",
    "assert module.recognized_kind('node', ['node', 'worker.js', 'codex']) is None",
    "assert module.recognized_kind('node', ['node', 'worker.js', claude]) is None",
    "assert module.recognized_kind('sh', ['sh', 'worker.sh', claude]) is None",
    "assert module.recognized_kind('node', ['node', '-r', 'omx', 'worker.js']) is None",
    "assert module.recognized_kind('node', ['node', '-e', 'worker()', 'codex']) is None",
    "assert module.recognized_kind('node', ['node', '--run', 'codex']) is None",
    "assert module.recognized_kind('node', ['node', '--unknown-option', 'codex']) is None",
    "assert module.recognized_kind('node', ['node', '--require', 'preload.js', 'codex.js']) == 'codex'",
    "assert module.recognized_kind('node', ['node', '--no-warnings', '--', claude, 'codex']) == 'claude'",
    "assert module.recognized_kind('MainThread', ['node', '--require=preload.js', '/opt/omx.js', 'resume']) == 'omx'",
    "assert module.OMX_WORKER.search('/repo/.omx/team/demo/worktrees/worker-1')",
    "import pathlib, tempfile",
    "fixture = tempfile.TemporaryDirectory()",
    "root = pathlib.Path(fixture.name)",
    "parent = root / '50'",
    "parent.mkdir()",
    "command = ['node', '/repo/apps/server/dist/transports/holder.js', '/tmp/holder.sock', '--', 'node', '/repo/apps/server/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', '--mode', 'rpc', '-ne', '-e', '/repo/apps/server/dist/adapters/pi-extension.js', '--offline', '--no-approve']",
    "(parent / 'cmdline').write_bytes(('\\0'.join(command) + '\\0').encode())",
    "(parent / 'status').write_text('Uid:\\t1200\\t1200\\t1200\\t1200\\n')",
    "assert module.rac_pi_process(str(root), 'pi', ['pi'], 50, 1200)",
    "command[command.index('rpc')] = 'json'",
    "(parent / 'cmdline').write_bytes(('\\0'.join(command) + '\\0').encode())",
    "assert not module.rac_pi_process(str(root), 'pi', ['pi'], 50, 1200)",
    "fixture.cleanup()",
    "module.os.pidfd_open = lambda pid, flags: 9",
    "module.os.close = lambda fd: None",
    "module.read_stat = lambda root, pid: ('S', 1, '456')",
    "module.read_text = lambda path, limit=65536: 'Uid:\\t1200\\t1200\\t1200\\t1200\\n'",
    "module.process_kind = lambda root, pid, uid=None: ('codex', 'codex\\0')",
    "module.os.readlink = lambda path: '/repo'",
    "module.has_agent_ancestor = lambda root, parent: False",
    "clock = iter([1.0, 2.0])",
    "module.time.time = lambda: next(clock)",
    "sent = []",
    "module.signal.pidfd_send_signal = lambda *args: sent.append(args)",
    "outcome = module.terminate({'pid': 123, 'startTime': '456', 'uid': 1200, 'kind': 'codex'}, 1500, '/fake')",
    "assert outcome['status'] == 'stale' and sent == []"
  ].join("\n");
  const result = spawnSync("/usr/bin/python3", ["-B", "-c", source, helper], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
