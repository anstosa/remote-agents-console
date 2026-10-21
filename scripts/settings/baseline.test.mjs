import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { extractDockerCopyPayload, probeRacHealth, proveInitialTargetBaseline } from "./baseline.mjs";
import { sha256 } from "./crypto.mjs";
import { atomicWriteFile } from "./fs.mjs";

const AUTH_ENV = "RAC_PASSWORD_HASH='$argon2id$fixture'\nRAC_SESSION_SECRET=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n";

// create one private baseline fixture root
function rootFixture(name) {
  const root = mkdtempSync(resolve(tmpdir(), name));
  chmodSync(root, 0o700);
  const controlRoot = resolve(root, "control");
  mkdirSync(controlRoot, { mode: 0o700 });
  return { root, controlRoot };
}

// encode one regular file in a minimal POSIX tar stream
function tarFile(name, bytes) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, 0o600);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, bytes.length);
  writeOctal(header, 136, 12, 0);
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, "0");
  header.write(checksumText, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 32;
  const padding = Buffer.alloc(Math.ceil(bytes.length / 512) * 512 - bytes.length);
  return Buffer.concat([header, bytes, padding, Buffer.alloc(1024)]);
}

// write one null-terminated tar octal field
function writeOctal(buffer, offset, width, value) {
  const text = value.toString(8).padStart(width - 1, "0");
  buffer.write(text, offset, width - 1, "ascii");
  buffer[offset + width - 1] = 0;
}

test("RAC bootstrap proves exact source environment and health state", async () => {
  const current = rootFixture("rac-baseline-rac-");
  const app = resolve(current.root, "app.json");
  const env = resolve(current.root, ".env");
  atomicWriteFile(app, '{"name":"before"}\n', 0o600);
  atomicWriteFile(env, AUTH_ENV, 0o600);
  const envHashes = {
    RAC_PASSWORD_HASH: sha256(Buffer.from("$argon2id$fixture")),
    RAC_SESSION_SECRET: sha256(Buffer.from("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"))
  };
  atomicWriteFile(resolve(current.controlRoot, "boot.json"), `${JSON.stringify({
    version: 1,
    generation: 1,
    bootNonce: "bootstrap_boot_nonce_01",
    hashes: { app: sha256(Buffer.from('{"name":"before"}\n')), env: sha256(Buffer.from(AUTH_ENV)) },
    environmentHashes: envHashes,
    environmentFileHashes: envHashes,
    listen: { host: "127.0.0.1", port: 8787 }
  })}\n`, 0o600);
  const descriptor = {
    generation: 1,
    kind: "systemd",
    controlRoot: current.controlRoot,
    sources: {
      app: { path: app, serverPath: app },
      env: { path: env, serverPath: env }
    },
    native: { unit: "remote-agent-console.service", environmentFile: env }
  };
  const runner = async (_command, args) => ({
    code: 0,
    stdout: Buffer.from(args.some((arg) => arg.includes("EnvironmentFiles")) ? `${env}\n` : ""),
    stderr: Buffer.alloc(0)
  });
  const proof = await proveInitialTargetBaseline(descriptor, "rac", { runner, healthProbe: async () => true });
  assert.equal(proof.hashes.app, sha256(Buffer.from('{"name":"before"}\n')));
  atomicWriteFile(app, '{"name":"drifted"}\n', 0o600);
  await assert.rejects(
    () => proveInitialTargetBaseline(descriptor, "rac", { runner, healthProbe: async () => true }),
    { code: "baseline-required" }
  );
});

test("Compose RAC bootstrap canonicalizes escaped dollar environment values", async () => {
  const current = rootFixture("rac-baseline-compose-env-");
  const app = resolve(current.root, "app.json");
  const env = resolve(current.root, ".env");
  atomicWriteFile(app, '{"name":"before"}\n', 0o600);
  atomicWriteFile(env, AUTH_ENV, 0o600);
  const envHashes = {
    RAC_PASSWORD_HASH: sha256(Buffer.from("$argon2id$fixture")),
    RAC_SESSION_SECRET: sha256(Buffer.from("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"))
  };
  atomicWriteFile(resolve(current.controlRoot, "boot.json"), `${JSON.stringify({
    version: 1,
    generation: 1,
    bootNonce: "compose_boot_nonce_00001",
    hashes: { app: sha256(Buffer.from('{"name":"before"}\n')), env: sha256(Buffer.from(AUTH_ENV)) },
    environmentHashes: envHashes,
    environmentFileHashes: envHashes,
    listen: { host: "127.0.0.1", port: 8787 }
  })}\n`, 0o600);
  const descriptor = {
    generation: 1,
    kind: "compose",
    controlRoot: current.controlRoot,
    hostCheckout: current.root,
    hostControlRoot: current.controlRoot,
    sources: {
      app: { path: app, serverPath: app },
      env: { path: env, serverPath: env }
    },
    compose: { projectDirectory: current.root, projectName: "rac", files: [], envFiles: [], profiles: [], options: {} }
  };
  const containerId = "1234567890abcdef";
  const healthCalls = [];
  let healthy = true;
  const runner = async (_command, args) => {
    // return the selected RAC container
    if (args.includes("ps")) {
      return { code: 0, stdout: Buffer.from(`${containerId}\n`), stderr: Buffer.alloc(0) };
    }
    // return its fixed Compose identity
    if (args[0] === "inspect") {
      return { code: 0, stdout: Buffer.from("true\nhealthy\nrac\nremote-agent-console\n[]\n"), stderr: Buffer.alloc(0) };
    }
    // probe the attested listener inside the exact Compose container
    if (args[0] === "exec") {
      healthCalls.push(args);
      return { code: healthy ? 0 : 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    // preserve Compose dollar escaping in the resolved model
    if (args.includes("--format")) {
      return { code: 0, stdout: Buffer.from(JSON.stringify({ services: { "remote-agent-console": { environment: {
        RAC_PASSWORD_HASH: "$$argon2id$$fixture",
        RAC_SESSION_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
      } } } })), stderr: Buffer.alloc(0) };
    }
    return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  const proof = await proveInitialTargetBaseline(descriptor, "rac", { runner });
  assert.deepEqual(proof.environmentHashes, envHashes);
  assert.equal(healthCalls.length, 1);
  assert.equal(healthCalls[0][1], containerId);
  assert.equal(healthCalls[0][2], "/usr/local/bin/node");
  assert.equal(healthCalls[0].includes("http://127.0.0.1:8787/healthz"), true);
  healthy = false;
  await assert.rejects(() => proveInitialTargetBaseline(descriptor, "rac", { runner }), { code: "baseline-required" });
});

test("Compose RAC health discovery shares the bounded probe deadline", async () => {
  const current = rootFixture("rac-baseline-compose-health-deadline-");
  const descriptor = {
    kind: "compose",
    compose: { projectDirectory: current.root, projectName: "rac", files: [], envFiles: [], profiles: [], options: {} }
  };
  const controller = new AbortController();
  let discoveryOptions;
  const healthy = await probeRacHealth(descriptor, { host: "127.0.0.1", port: 8787 }, {
    remainingMs: 123,
    signal: controller.signal,
    runner: async (_command, _args, options) => {
      // cancel while Compose discovery owns the shared probe signal
      discoveryOptions = options;
      controller.abort();
      throw new Error("cancelled");
    }
  });

  assert.equal(healthy, false);
  assert.equal(discoveryOptions.timeoutMs, 123);
  assert.equal(discoveryOptions.signal.aborted, true);
});

test("Cloudflare bootstrap proves direct bind bytes through Docker copy", async () => {
  const current = rootFixture("rac-baseline-cloud-");
  const config = resolve(current.root, "cloudflared.yml");
  const credentials = resolve(current.root, "credentials.json");
  const configBytes = Buffer.from("tunnel: 00000000-0000-0000-0000-000000000000\n");
  const consumedConfigBytes = Buffer.from("tunnel: 11111111-1111-1111-1111-111111111111\n");
  const credentialBytes = Buffer.from('{"TunnelID":"00000000-0000-0000-0000-000000000000"}\n');
  atomicWriteFile(config, configBytes, 0o600);
  atomicWriteFile(credentials, credentialBytes, 0o600);
  const descriptor = {
    kind: "compose",
    sources: {
      cloudflared: { path: config },
      "cloudflared-credentials": { path: credentials }
    },
    compose: { projectDirectory: current.root, projectName: "rac", files: [], envFiles: [], profiles: ["tunnel"], options: {} }
  };
  const containerId = "0123456789abcdef";
  const mounts = [
    { Type: "bind", Source: config, Destination: "/etc/cloudflared/config.yml", RW: false },
    { Type: "bind", Source: credentials, Destination: "/etc/cloudflared/credentials.json", RW: false }
  ];
  const runner = async (_command, args) => {
    // return the fixed service identity
    if (args.includes("ps")) return { code: 0, stdout: Buffer.from(`${containerId}\n`), stderr: Buffer.alloc(0) };
    // return only nonsecret inspect metadata
    if (args[0] === "inspect") return { code: 0, stdout: Buffer.from(`true\n\nrac\ncloudflared\n${JSON.stringify(mounts)}\n`), stderr: Buffer.alloc(0) };
    // return the selected mounted file tar stream
    if (args[0] === "cp") {
      const bytes = args[1].endsWith("config.yml") ? consumedConfigBytes : credentialBytes;
      return { code: 0, stdout: tarFile("mounted", bytes), stderr: Buffer.alloc(0) };
    }
    return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  const proof = await proveInitialTargetBaseline(descriptor, "cloudflared", { runner });
  assert.equal(proof.targetProofs.cloudflared.containerId, containerId);
  assert.equal(proof.hashes.cloudflared, sha256(consumedConfigBytes));
  assert.equal(Buffer.from(proof.consumedSources.cloudflared, "base64").toString("utf8"), consumedConfigBytes.toString("utf8"));
  assert.equal(extractDockerCopyPayload(tarFile("config", configBytes)).toString("utf8"), configBytes.toString("utf8"));
});

test("native Cloudflare bootstrap proves one stable process and unchanged source inodes", async () => {
  const current = rootFixture("rac-baseline-native-cloud-");
  const config = resolve(current.root, "cloudflared.yml");
  const credentials = resolve(current.root, "credentials.json");
  const procRoot = resolve(current.root, "proc");
  const pid = 4242;
  const processRoot = resolve(procRoot, String(pid));
  mkdirSync(processRoot, { recursive: true, mode: 0o700 });
  const configBytes = Buffer.from(`tunnel: 00000000-0000-0000-0000-000000000000\ncredentials-file: ${credentials}\nmetrics: 127.0.0.1:49312\n`);
  const credentialBytes = Buffer.from('{"TunnelID":"00000000-0000-0000-0000-000000000000"}\n');
  atomicWriteFile(config, configBytes, 0o600);
  atomicWriteFile(credentials, credentialBytes, 0o600);
  atomicWriteFile(resolve(processRoot, "cmdline"), Buffer.from(`/usr/bin/cloudflared\0tunnel\0--config\0${config}\0run\0`), 0o600);
  const statFields = Array(19).fill("0");
  statFields[18] = "123456";
  atomicWriteFile(resolve(processRoot, "stat"), `${pid} (cloudflared) S ${statFields.join(" ")}\n`, 0o600);
  const startedAt = Date.now() + 500;
  const serviceState = [
    `MainPID=${pid}`,
    "ActiveState=active",
    "SubState=running",
    `ExecMainStartTimestamp=${new Date(startedAt).toISOString()}`,
    ""
  ].join("\n");
  const runner = async (command) => ({
    code: command === "systemctl" ? 0 : 1,
    stdout: command === "systemctl" ? Buffer.from(serviceState) : Buffer.alloc(0),
    stderr: Buffer.alloc(0)
  });
  let probed;
  const descriptor = {
    kind: "systemd",
    sources: {
      cloudflared: { path: config },
      "cloudflared-credentials": { path: credentials }
    },
    native: { cloudflaredUnit: "cloudflared.service" }
  };
  const proof = await proveInitialTargetBaseline(descriptor, "cloudflared", {
    runner,
    procRoot,
    now: () => startedAt + 1_000,
    cloudflaredHealthProbe: async (listen) => {
      probed = listen;
      return true;
    }
  });
  assert.deepEqual(probed, { host: "127.0.0.1", port: 49312 });
  assert.deepEqual(proof.targetProofs.cloudflared, { unit: "cloudflared.service", pid, startedAt });
  assert.deepEqual(proof.nativeCommand, ["/usr/bin/cloudflared", "tunnel", "--config", config, "run"]);
  assert.equal(proof.hashes.cloudflared, sha256(configBytes));
  assert.equal(proof.hashes["cloudflared-credentials"], sha256(credentialBytes));
});

test("native Cloudflare bootstrap rejects sources changed after process start", async () => {
  const current = rootFixture("rac-baseline-native-drift-");
  const config = resolve(current.root, "cloudflared.yml");
  const credentials = resolve(current.root, "credentials.json");
  const procRoot = resolve(current.root, "proc");
  const pid = 5252;
  const processRoot = resolve(procRoot, String(pid));
  mkdirSync(processRoot, { recursive: true, mode: 0o700 });
  atomicWriteFile(config, `credentials-file: ${credentials}\n`, 0o600);
  atomicWriteFile(credentials, "{}\n", 0o600);
  atomicWriteFile(resolve(processRoot, "cmdline"), Buffer.from(`/usr/bin/cloudflared\0tunnel\0--config=${config}\0run\0`), 0o600);
  const statFields = Array(19).fill("0");
  statFields[18] = "654321";
  atomicWriteFile(resolve(processRoot, "stat"), `${pid} (cloudflared) S ${statFields.join(" ")}\n`, 0o600);
  const startedAt = Date.now() - 60_000;
  const runner = async () => ({
    code: 0,
    stdout: Buffer.from(`MainPID=${pid}\nActiveState=active\nSubState=running\nExecMainStartTimestamp=${new Date(startedAt).toISOString()}\n`),
    stderr: Buffer.alloc(0)
  });
  await assert.rejects(() => proveInitialTargetBaseline({
    kind: "systemd",
    sources: {
      cloudflared: { path: config },
      "cloudflared-credentials": { path: credentials }
    },
    native: { cloudflaredUnit: "cloudflared.service" }
  }, "cloudflared", { runner, procRoot }), { code: "baseline-required" });
});
