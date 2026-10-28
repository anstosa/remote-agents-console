import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import test from "node:test";
import { projectMountsChanged, synchronizeProjectMounts } from "./project-mounts.mjs";
import { composePrefix, validateComposeCandidates } from "./validate.mjs";
import { ensureRecoveryKey, processOperation, validateRequest } from "./operations.mjs";
import { sha256 } from "./crypto.mjs";

const override = `services:
  remote-agent-console:
    environment:
      EXISTING: yes
    volumes:
      - /manual/source:/manual/target:ro # operator mount
`;

const application = (projects) => `${JSON.stringify({ name: "RAC", projects }, null, 2)}\n`;
const model = (volumes = []) => ({ services: { "remote-agent-console": { volumes } } });

test("adds one writable managed bind without changing operator bytes", () => {
  const result = synchronizeProjectMounts(override, application([]), application([{ id: "new", path: "/worktrees/new", hostPath: "/host/new" }]), model(), "/stack");
  assert.match(result, /rac-project-mounts:start/);
  assert.match(result, /source: "\/host\/new"/);
  assert.match(result, /target: "\/worktrees\/new"/);
  assert.match(result, /read_only: false/);
  assert.match(result, /create_host_path: false/);
  assert.match(result, /- \/manual\/source:\/manual\/target:ro # operator mount/);
  assert.match(result, /EXISTING: yes/);
});

// keep generated volumes inside their service boundary
test("inserts before later top-level Compose sections", () => {
  const source = `${override}networks:\n  default: {}\nvolumes:\n  cache: {}\n`;
  const result = synchronizeProjectMounts(source, application([]), application([{ id: "new", path: "/new", hostPath: "/host/new" }]), model(), "/stack");
  assert.ok(result.indexOf("rac-project-mounts:end") < result.indexOf("networks:"));
  assert.match(result, /networks:\n  default: \{\}\nvolumes:\n  cache: \{\}/);
});

// refuse unsupported service syntax without guessing YAML ownership
test("rejects quoted service syntax", () => {
  assert.throws(() => synchronizeProjectMounts('services:\n  "remote-agent-console": {}\n', application([]), application([{ id: "new", path: "/new", hostPath: "/host/new" }]), model(), "/stack"), /project-mount-yaml-unsupported/);
});

test("uses an existing ancestor bind only when its host mapping matches", () => {
  const result = synchronizeProjectMounts(override, application([]), application([{ id: "nested", path: "/workspace/nested" }]), model([{ type: "bind", source: "/workspace", target: "/workspace" }]), "/stack");
  assert.doesNotMatch(result, /source: "\/workspace\/nested"/);
  assert.match(result, /rac-project-mounts:start\n      # rac-project-mounts:end/);
});

test("overrides the most-specific mismatching child instead of reusing its parent", () => {
  const candidate = application([{ id: "nested", path: "/projects/foo", hostPath: "/host/projects/foo" }]);
  const volumes = [{ type: "bind", source: "/host/projects", target: "/projects" }, { type: "bind", source: "/other", target: "/projects/foo", read_only: true }];
  const result = synchronizeProjectMounts(override, application([]), candidate, model(volumes), "/stack");
  assert.match(result, /source: "\/host\/projects\/foo"/);
  assert.match(result, /target: "\/projects\/foo"[\s\S]*read_only: true/);
  const named = synchronizeProjectMounts(override, application([]), candidate, model([volumes[0], { type: "volume", source: "named", target: "/projects/foo" }]), "/stack");
  assert.match(named, /source: "\/host\/projects\/foo"/);
});

test("adds a direct bind when an ancestor target maps to a different host path", () => {
  const result = synchronizeProjectMounts(override, application([]), application([{ id: "nested", path: "/workspace/nested" }]), model([{ type: "bind", source: "/host/checkout", target: "/workspace" }]), "/stack");
  assert.match(result, /source: "\/workspace\/nested"/);
  assert.match(result, /target: "\/workspace\/nested"/);
});

test("requires an explicit hostPath to match the effective mount source", () => {
  const result = synchronizeProjectMounts(override, application([]), application([{ id: "nested", path: "/workspace/nested", hostPath: "/different/nested" }]), model([{ type: "bind", source: "/host/checkout", target: "/workspace" }]), "/stack");
  assert.match(result, /source: "\/different\/nested"/);
  assert.match(result, /target: "\/workspace\/nested"/);
});

test("never shadows the fixed workspace mount", () => {
  const workspace = model([{ type: "bind", source: "/host/checkout", target: "/workspace" }]);
  assert.throws(() => synchronizeProjectMounts(override, application([]), application([{ id: "rac", path: "/workspace" }]), workspace, "/stack"), /project-mount-host-path-required/);
  const matched = synchronizeProjectMounts(override, application([]), application([{ id: "rac", path: "/workspace", hostPath: "/host/checkout" }]), workspace, "/stack");
  assert.doesNotMatch(matched, /source: "\/host\/checkout"/);
  const current = application([{ id: "rac", path: "/workspace" }]);
  const unchanged = synchronizeProjectMounts(override, current, application([{ id: "rac", path: "/workspace" }, { id: "other", path: "/other", hostPath: "/host/other" }]), workspace, "/stack");
  assert.doesNotMatch(unchanged, /source: "\/workspace"/);
  assert.match(unchanged, /source: "\/host\/other"/);
});

test("does not retroactively manage an unchanged absolute alias", () => {
  const current = application([{ id: "legacy", path: "/legacy" }]);
  const candidate = application([{ id: "legacy", path: "/legacy" }, { id: "new", path: "/new", hostPath: "/host/new" }]);
  const result = synchronizeProjectMounts(override, current, candidate, model([{ type: "bind", source: "/host/legacy", target: "/legacy" }]), "/stack");
  assert.doesNotMatch(result, /source: "\/legacy"/);
  assert.match(result, /source: "\/host\/new"/);
});

test("repairs a malformed current application with strict candidate mounts", () => {
  const candidate = application([{ id: "repaired", path: "/repaired", hostPath: "/host/repaired" }]);
  const result = synchronizeProjectMounts(override, "{", candidate, model([{ type: "bind", source: "/old", target: "/repaired", read_only: true }]), "/stack");
  assert.match(result, /source: "\/host\/repaired"/);
  assert.match(result, /read_only: true/);
  assert.throws(() => synchronizeProjectMounts(override, application([]), '{"projects":"invalid"}', model(), "/stack"), /invalid-project-mounts/);
});

// one damaged sibling cannot erase a known read-only transition
test("retains a valid current Project beside malformed siblings during repair", () => {
  const previous = { id: "kept", path: "/old", hostPath: "/host/old" };
  const current = application([previous, { id: "damaged" }]);
  const candidate = application([{ ...previous, path: "/new", hostPath: "/host/new" }]);
  const result = synchronizeProjectMounts(override, current, candidate, model([{ type: "bind", source: "/host/old", target: "/old", read_only: true }]), "/stack");
  assert.match(result, /target: "\/new"[\s\S]*read_only: true/);
});

// unknown application bytes still require removal of proven RAC-owned binds
test("cleans an owned block when damaged application bytes are repaired to no Projects", () => {
  const selected = application([{ id: "old", path: "/old", hostPath: "/host/old" }]);
  const owned = synchronizeProjectMounts(override, application([]), selected, model(), "/stack");
  assert.equal(projectMountsChanged("{", application([]), true), true);
  assert.equal(projectMountsChanged("{", application([]), false), false);
  const result = synchronizeProjectMounts(owned, "{", application([]), model([{ type: "bind", source: "/host/old", target: "/old" }]), "/stack");
  assert.doesNotMatch(result, /source: "\/host\/old"|target: "\/old"/);
  assert.ok(result.includes("- /manual/source:/manual/target:ro # operator mount"));
});

// conflicting stable identities cannot choose a previous policy by row order
test("rejects ambiguous current identities while repairing malformed siblings", () => {
  const current = application([{ id: "same", path: "/one", hostPath: "/host/one" }, { id: "same", path: "/two", hostPath: "/host/two" }, {}]);
  const candidate = application([{ id: "same", path: "/new", hostPath: "/host/new" }]);
  assert.throws(() => synchronizeProjectMounts(override, current, candidate, model(), "/stack"), /project-mount-transition-ambiguous/);
});

// damaged truth cannot infer a transition from an unaccounted canonical owned bind
test("rejects a nonempty repair with an unaccounted legacy owned target", () => {
  const previous = application([{ id: "old", path: "/old", hostPath: "/host/old" }]);
  const owned = synchronizeProjectMounts(override, application([]), previous, model(), "/stack").replace('target: "/old"', 'target: "/child/../old"');
  assert.throws(() => synchronizeProjectMounts(owned, "{", application([{ id: "new", path: "/new", hostPath: "/host/new" }]), model(), "/stack"), /project-mount-transition-ambiguous/);
});

test("changes a Project bind while retaining readonly and bind options", () => {
  const current = application([{ id: "project", path: "/worktrees/project", hostPath: "/host/old" }]);
  const candidate = application([{ id: "project", path: "/worktrees/renamed", hostPath: "/host/new" }]);
  const result = synchronizeProjectMounts(override, current, candidate, model([{ type: "bind", source: "/host/old", target: "/worktrees/project", read_only: true, consistency: "cached", bind: { propagation: "rshared", create_host_path: true } }]), "/stack");
  assert.match(result, /source: "\/host\/new"/);
  assert.match(result, /target: "\/worktrees\/renamed"/);
  assert.match(result, /read_only: true/);
  assert.match(result, /consistency: "cached"/);
  assert.match(result, /propagation: "rshared"/);
  assert.match(result, /create_host_path: false/);
});

test("inherits readonly options from the most-specific covering ancestor", () => {
  const current = application([{ id: "project", path: "/projects/old", hostPath: "/host/projects/old" }]);
  const candidate = application([{ id: "project", path: "/outside/new", hostPath: "/other/new" }]);
  const result = synchronizeProjectMounts(override, current, candidate, model([{ type: "bind", source: "/host/projects", target: "/projects", read_only: true, bind: { propagation: "rprivate" } }]), "/stack");
  assert.match(result, /target: "\/outside\/new"[\s\S]*read_only: true/);
  assert.match(result, /propagation: "rprivate"/);
});

test("inherits options only from the effective previous mount", () => {
  const current = application([{ id: "project", path: "/projects/foo/bar", hostPath: "/other/bar" }]);
  const candidate = application([{ id: "project", path: "/outside/new", hostPath: "/host/new" }]);
  const parent = { type: "bind", source: "/host/projects", target: "/projects", read_only: false, bind: { propagation: "rshared" } };
  const child = { type: "bind", source: "/other", target: "/projects/foo", read_only: true, bind: { propagation: "rprivate" } };
  const result = synchronizeProjectMounts(override, current, candidate, model([parent, child]), "/stack");
  assert.match(result, /target: "\/outside\/new"[\s\S]*read_only: true/);
  assert.match(result, /propagation: "rprivate"/);
  assert.doesNotMatch(result, /propagation: "rshared"/);
  const named = synchronizeProjectMounts(override, current, candidate, model([parent, { type: "volume", source: "named", target: "/projects/foo" }]), "/stack");
  assert.match(named, /target: "\/outside\/new"[\s\S]*read_only: false/);
  assert.doesNotMatch(named, /propagation:/);
});

test("rejects an ambiguous idless compound edit", () => {
  const current = application([{ path: "/one", hostPath: "/host/one" }, { path: "/two", hostPath: "/host/two" }]);
  const candidate = application([{ path: "/three", hostPath: "/host/three" }, { path: "/four", hostPath: "/host/four" }]);
  assert.throws(() => synchronizeProjectMounts(override, current, candidate, model([{ type: "bind", source: "/host/one", target: "/one", read_only: true }]), "/stack"), /project-mount-transition-ambiguous/);
});

test("retains readonly options for one unambiguous idless change", () => {
  const current = application([{ path: "/one", hostPath: "/host/one" }]);
  const candidate = application([{ path: "/two", hostPath: "/host/two" }]);
  const result = synchronizeProjectMounts(override, current, candidate, model([{ type: "bind", source: "/host/one", target: "/one", read_only: true }]), "/stack");
  assert.match(result, /target: "\/two"[\s\S]*read_only: true/);
});

test("regenerates and removes only stale owned mounts", () => {
  const current = application([{ id: "project", path: "/worktrees/old", hostPath: "/host/old" }]);
  const candidate = application([]);
  const owned = synchronizeProjectMounts(override, application([]), current, model(), "/stack");
  const result = synchronizeProjectMounts(owned, current, candidate, model([{ type: "bind", source: "/host/old", target: "/worktrees/old", read_only: false }]), "/stack");
  assert.doesNotMatch(result, /\/host\/old|\/worktrees\/old/);
  assert.match(result, /- \/manual\/source:\/manual\/target:ro # operator mount/);
  assert.equal(synchronizeProjectMounts(owned, application([]), current, model([{ type: "bind", source: "/host/old", target: "/worktrees/old", read_only: false }]), "/stack"), owned);
});

test("escapes literal dollars in generated mount paths", () => {
  const result = synchronizeProjectMounts(override, application([]), application([{ id: "cash", path: "/worktrees/$cash", hostPath: "/host/$cash" }]), model(), "/stack");
  assert.match(result, /source: "\/host\/\$\$cash"/);
  assert.match(result, /target: "\/worktrees\/\$\$cash"/);
});

test("keeps unchanged relative Projects but rejects new relative mount paths", () => {
  const relative = application([{ id: "legacy", path: "relative/project" }]);
  const next = application([{ id: "legacy", path: "relative/project" }, { id: "new", path: "/worktrees/new", hostPath: "/host/new" }]);
  assert.doesNotThrow(() => synchronizeProjectMounts(override, relative, next, model(), "/stack"));
  assert.throws(() => synchronizeProjectMounts(override, application([]), relative, model(), "/stack"), /project-mount-path-not-absolute/);
});

// reject damaged managed-block boundaries
test("rejects broken ownership markers", () => {
  const candidate = application([{ id: "project", path: "/new", hostPath: "/host/new" }]);
  assert.throws(() => synchronizeProjectMounts(`${override}      # rac-project-mounts:start\n`, application([]), candidate, model(), "/stack"), /project-mount-marker-invalid/);
});

// preserve the scalar-only bind option boundary
test("rejects unsupported cloned options", () => {
  const candidate = application([{ id: "project", path: "/new", hostPath: "/host/new" }]);
  assert.throws(() => synchronizeProjectMounts(override, application([{ id: "project", path: "/old", hostPath: "/host/old" }]), candidate, model([{ type: "bind", source: "/host/old", target: "/old", bind: { unsupported: { nested: true } } }]), "/stack"), /project-mount-option-unsupported/);
});

// keep fixed runtime mounts outside automatic ownership
test("rejects protected Project targets", () => {
  assert.throws(() => synchronizeProjectMounts(override, application([]), application([{ id: "control", path: "/run/rac-settings-control" }]), model(), "/stack"), /project-mount-host-path-required/);
});

// one container target cannot select two host sources
test("rejects conflicting Project targets", () => {
  assert.throws(() => synchronizeProjectMounts(override, application([]), application([{ id: "one", path: "/same", hostPath: "/host/one" }, { id: "two", path: "/same", hostPath: "/host/two" }]), model(), "/stack"), /project-mount-target-conflict/);
});

// protect read-only destinations even when the prior Project was writable
test("retains a read-only destination when a writable Project moves", () => {
  const current = application([{ id: "project", path: "/old", hostPath: "/host/old" }]);
  const candidate = application([{ id: "project", path: "/new", hostPath: "/host/new" }]);
  const result = synchronizeProjectMounts(override, current, candidate, model([
    { type: "bind", source: "/host/old", target: "/old", read_only: false },
    { type: "bind", source: "/operator/new", target: "/new", read_only: true }
  ]), "/stack");
  assert.match(result, /source: "\/host\/new"[\s\S]*read_only: true/);
});

// retain the destination ancestor's read-only boundary for new child binds
test("keeps a new mismatching child beneath a read-only ancestor read-only", () => {
  const result = synchronizeProjectMounts(override, application([]), application([{ id: "new", path: "/protected/new", hostPath: "/host/new" }]), model([
    { type: "bind", source: "/operator/protected", target: "/protected", read_only: true }
  ]), "/stack");
  assert.match(result, /source: "\/host\/new"[\s\S]*read_only: true/);
});

// host-source corrections do not re-author an unchanged legacy target
test("updates a legacy alias host source using its canonical mount destination", () => {
  const current = application([{ id: "legacy", path: "/child/../same", hostPath: "/host/old" }]);
  const candidate = application([{ id: "legacy", path: "/child/../same", hostPath: "/host/new" }]);
  const result = synchronizeProjectMounts(override, current, candidate, model([{ type: "bind", source: "/host/old", target: "/same", read_only: true }]), "/stack");
  assert.match(result, /source: "\/host\/new"[\s\S]*target: "\/same"[\s\S]*read_only: true/);
});

// an unchanged owned alias must not disappear when another Project is added
test("regenerates an owned legacy alias using its canonical target", () => {
  const legacy = { id: "legacy", path: "/child/../same", hostPath: "/host/old" };
  const owned = `${override}      # rac-project-mounts:start\n      - type: bind\n        source: "/host/old"\n        target: "/child/../same"\n        read_only: true\n        bind:\n          create_host_path: false\n      # rac-project-mounts:end\n`;
  const result = synchronizeProjectMounts(owned, application([legacy]), application([legacy, { id: "new", path: "/new", hostPath: "/host/new" }]), model([{ type: "bind", source: "/host/old", target: "/same", read_only: true }]), "/stack");
  assert.match(result, /source: "\/host\/old"[\s\S]*target: "\/same"[\s\S]*read_only: true/);
  assert.match(result, /source: "\/host\/new"/);
  assert.doesNotMatch(result, /target: "\/child\/\.\.\/same"/);
  assert.equal(result.match(/rac-project-mounts:start/gu)?.length, 1);
});

// equivalent host spellings do not create a false effective-target conflict
test("reuses a canonical bind for equivalent legacy and canonical source spellings", () => {
  const legacy = { id: "legacy", path: "/child/../same", hostPath: "/host/old" };
  const result = synchronizeProjectMounts(override, application([legacy]), application([legacy, { id: "same", path: "/same", hostPath: "/host/./old" }]), model([{ type: "bind", source: "/host/old", target: "/same", read_only: true }]), "/stack");
  assert.doesNotMatch(result, /target: "\/same"/);
});

// retained aliases still participate in effective destination conflicts
test("rejects a new canonical target that conflicts with a retained legacy alias", () => {
  const legacy = { id: "legacy", path: "/child/../same", hostPath: "/host/old" };
  assert.throws(() => synchronizeProjectMounts(override, application([legacy]), application([legacy, { id: "new", path: "/same", hostPath: "/host/new" }]), model(), "/stack"), /project-mount-target-conflict/);
});

// protected targets cannot be changed through a legacy alias
test("protects the canonical workspace when a legacy alias host source changes", () => {
  const current = application([{ id: "legacy", path: "/workspace/", hostPath: "/host/old" }]);
  const candidate = application([{ id: "legacy", path: "/workspace/", hostPath: "/host/new" }]);
  assert.throws(() => synchronizeProjectMounts(override, current, candidate, model([{ type: "bind", source: "/host/old", target: "/workspace" }]), "/stack"), /project-mount-host-path-required/);
});

// canonical destinations keep aliases out of conflict and protected-path checks
for (const target of ["/workspace/", "/child/../workspace", "/run/./rac-settings-control", "/run/rac-settings-control/", "/child/../same"]) test(`rejects newly authored target alias ${target}`, () => {
  assert.throws(() => synchronizeProjectMounts(override, application([]), application([{ id: "alias", path: target, hostPath: "/host/new" }]), model(), "/stack"), /project-mount-path-not-canonical/);
});

// alias checks do not retroactively alter existing operator mappings
test("leaves an unchanged legacy target alias outside automatic ownership", () => {
  const legacy = { id: "legacy", path: "/legacy/../same", hostPath: "/host/legacy" };
  const result = synchronizeProjectMounts(override, application([legacy]), application([legacy, { id: "new", path: "/new", hostPath: "/host/new" }]), model(), "/stack");
  assert.doesNotMatch(result, /source: "\/host\/legacy"/);
  assert.match(result, /source: "\/host\/new"/);
});

// duplicate unavailable Projects still describe one effective mount
test("ignores duplicate mount-pair multiplicity", () => {
  const once = application([{ id: "one", path: "/missing", hostPath: "/host/missing" }]);
  const twice = application([{ id: "one", path: "/missing", hostPath: "/host/missing" }, { id: "two", path: "/missing", hostPath: "/host/missing" }]);
  assert.equal(projectMountsChanged(once, twice), false);
  assert.equal(projectMountsChanged(twice, once), false);
  assert.equal(synchronizeProjectMounts(override, twice, once, model(), "/stack"), override);
});

// encode path tuples without a delimiter collision
test("distinguishes mount pairs containing the former NUL delimiter", () => {
  const current = application([{ id: "project", hostPath: "/a", path: "/b\0/c" }]);
  const candidate = application([{ id: "project", hostPath: "/a\0/b", path: "/c" }]);
  assert.equal(projectMountsChanged(current, candidate), true);
});

test("ignores application changes that do not alter Project mounts", () => {
  assert.equal(projectMountsChanged(application([{ id: "same", path: "/same" }]), `${JSON.stringify({ name: "Changed", projects: [{ id: "same", path: "/same" }] })}\n`), false);
  assert.equal(projectMountsChanged("{", application([]), false), false);
});

// independently enforce installed override authority while retaining override-free repair
for (const scenario of [
  { name: "rejects a Compose Project change without an enlisted override candidate", current: application([]), candidate: application([{ id: "new", path: "/new", hostPath: "/host/new" }]), reject: true },
  { name: "repairs unknown application bytes to no Projects without an installed override", current: "{", candidate: application([]), reject: false },
  { name: "rejects unknown empty repair when an installed override was not enlisted", current: "{", candidate: application([]), installedOverride: true, reject: true }
]) test(scenario.name, async () => {
  const root = mkdtempSync(join(tmpdir(), "rac-project-enlistment-"));
  chmodSync(root, 0o700);
  try {
    const control = join(root, "control");
    const stage = join(control, "staging", "missing-override");
    const app = join(root, "config.json");
    const current = scenario.current;
    mkdirSync(stage, { recursive: true, mode: 0o700 });
    writeFileSync(app, current);
    writeFileSync(join(stage, "app"), scenario.candidate);
    const descriptor = { kind: "compose", controlRoot: control, sources: { app: { path: app, kind: "json", apply: "rac-restart" } } };
    // installed source knowledge is independent of request-supplied candidates
    if (scenario.installedOverride) {
      const path = join(root, "compose.override.yaml");
      writeFileSync(path, override);
      descriptor.sources["compose-override"] = { path, kind: "compose", apply: "rac-restart" };
    }
    const request = { version: 1, id: "missing-override", kind: "validate", generation: 1, sources: [{ id: "app", contentHash: sha256(Buffer.from(current)), candidate: "app" }] };
    // retain separate success and rejection contracts at the host boundary
    if (scenario.reject) await assert.rejects(validateRequest(descriptor, request), /project-mount-override-required/);
    else await validateRequest(descriptor, request);
    assert.equal(readFileSync(app, "utf8"), current);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// exact destinations retain their raw long-form uniqueness key
test("retains a raw exact-destination key while correcting its source", () => {
  const current = application([{ id: "legacy", path: "/child/../same", hostPath: "/host/old" }]);
  const candidate = application([{ id: "legacy", path: "/child/../same", hostPath: "/host/new" }]);
  const result = synchronizeProjectMounts(override, current, candidate, model([{ type: "bind", source: "/host/old", target: "/operator/../same", read_only: true }]), "/stack");
  assert.match(result, /source: "\/host\/new"[\s\S]*target: "\/operator\/\.\.\/same"[\s\S]*read_only: true/);
});

// a parent destination cannot donate its merge key to a new child
test("keeps a new child destination independent of its raw ancestor key", () => {
  const result = synchronizeProjectMounts(override, application([]), application([{ id: "new", path: "/parent/child", hostPath: "/host/new" }]), model([{ type: "bind", source: "/operator/parent", target: "/operator/../parent", read_only: true }]), "/stack");
  assert.match(result, /source: "\/host\/new"[\s\S]*target: "\/parent\/child"/);
});

// inherited options cannot donate a previous destination key after a move
test("keeps a moved destination independent of its previous raw merge key", () => {
  const current = application([{ id: "legacy", path: "/child/../old", hostPath: "/host/old" }]);
  const candidate = application([{ id: "legacy", path: "/new", hostPath: "/host/new" }]);
  const result = synchronizeProjectMounts(override, current, candidate, model([{ type: "bind", source: "/host/old", target: "/operator/../old", read_only: true }]), "/stack");
  assert.match(result, /source: "\/host\/new"[\s\S]*target: "\/new"[\s\S]*read_only: true/);
});

// exercise real Compose parsing without creating containers or changing live sources
for (const scenario of [
  { name: "literal dollar paths", style: "none" },
  { name: "short legacy source corrections", style: "short" },
  { name: "long legacy source corrections", style: "long" },
  { name: "committed long-form source corrections", style: "long", commit: true },
  { name: "committed empty repair with owned mount cleanup", style: "long", cleanup: true, commit: true },
  { name: "unknown owned transition without publication", style: "long", unknownOwned: true, rejection: true },
  { name: "repeated managed long-form corrections", style: "long", managed: true },
  { name: "unsupported interpolated long-form corrections", style: "long", interpolated: true, rejection: true },
  { name: "distinct authored long-form spelling", style: "long", distinctTarget: true },
  { name: "unquoted metadata collision", style: "none", collision: "x-rac-project-mount-source" },
  { name: "double-quoted metadata collision", style: "none", collision: '"x-rac-project-mount-source"' },
  { name: "single-quoted metadata collision", style: "none", collision: "'x-rac-project-mount-source'" }
]) test(`${scenario.rejection ? "rejects" : "validates"} ${scenario.name} through real Compose`, async (context) => {
  try { execFileSync("docker", ["compose", "version"], { stdio: "ignore" }); } catch { /* require the actual CLI for this integration seam */ context.skip("Docker Compose unavailable"); return; }
  const root = mkdtempSync(join(tmpdir(), "rac-project-mounts-"));
  chmodSync(root, 0o700);
  try {
    const control = join(root, "control");
    const id = "project_mounts_case_0001";
    const stage = join(control, "staging", id);
    const app = join(root, "config.json");
    const env = join(root, ".env");
    const compose = join(root, "compose.yaml");
    const composeOverride = join(root, "compose.override.yaml");
    mkdirSync(stage, { recursive: true, mode: 0o700 });
    const legacy = scenario.style !== "none";
    const hostPath = join(root, "host $cash $$double path");
    const oldHostPath = join(root, "host-old");
    const target = legacy ? "/child/../same" : "/worktrees/$cash $$double path";
    const authoredTarget = scenario.distinctTarget ? "/operator/../same" : target;
    const currentApplication = scenario.cleanup || scenario.unknownOwned ? "{" : application(legacy ? [{ id: "project", path: target, hostPath: oldHostPath }] : []);
    writeFileSync(app, currentApplication);
    writeFileSync(env, `RAC_TEST_TARGET=${target}\n`);
    writeFileSync(compose, `services:\n  remote-agent-console:\n    image: alpine\n    healthcheck:\n      test: ["CMD", "true"]\n    environment:\n      RAC_CONFIG: /workspace/config.json\n      RAC_CONFIG_WRITE_PATH: /workspace/config.json\n      RAC_SERVER_CHECKOUT: /workspace\n      RAC_PASSWORD_HASH: $$argon2id$$fixture\n      RAC_SESSION_SECRET: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n    volumes:\n      - type: bind\n        source: ${JSON.stringify(root)}\n        target: /workspace\n      - type: bind\n        source: ${JSON.stringify(control)}\n        target: /run/rac-settings-control\n`);
    let currentOverride = "services:\n  remote-agent-console:\n    volumes:\n";
    // retain each original operator syntax as the actual merge input
    if (legacy) {
      const longTarget = scenario.interpolated ? "${RAC_TEST_TARGET}" : JSON.stringify(authoredTarget);
      const longMount = `      - type: bind\n        source: ${JSON.stringify(oldHostPath)}\n        target: ${longTarget}\n        read_only: true\n`;
      // damaged-current scenarios own only the marked bind and retain a manual sentinel
      if (scenario.cleanup || scenario.unknownOwned) currentOverride += `      - /manual/source:/manual/target:ro # operator mount\n      # rac-project-mounts:start\n${longMount}      # rac-project-mounts:end\n`;
      else currentOverride += scenario.style === "short" ? `      - ${oldHostPath}:${authoredTarget}:ro\n` : longMount;
      // identical long-form spellings are valid across operator and owned entries
      if (scenario.managed) currentOverride += `      # rac-project-mounts:start\n${longMount}      # rac-project-mounts:end\n`;
    }
    // parsed key collisions must not bypass reserved metadata ownership
    if (scenario.collision) currentOverride += `${scenario.collision}: {}\n`;
    writeFileSync(composeOverride, currentOverride);
    writeFileSync(join(stage, "app"), application(scenario.cleanup ? [] : [{ id: "project", path: scenario.unknownOwned ? "/new" : target, hostPath }]));
    writeFileSync(join(stage, "compose-override"), currentOverride);
    const descriptor = {
      generation: 1,
      kind: "compose",
      controlRoot: control,
      hostCheckout: root,
      hostControlRoot: control,
      serverCheckout: "/workspace",
      allowedRoots: [root],
      sources: {
        app: { path: app, serverPath: "/workspace/config.json", kind: "json", apply: "rac-restart" },
        env: { path: env, kind: "env", apply: "rac-restart" },
        compose: { path: compose, kind: "compose", apply: "rac-restart" },
        "compose-override": { path: composeOverride, kind: "compose", apply: "rac-restart" }
      },
      compose: { projectDirectory: root, projectName: "project-mounts", files: [compose, composeOverride], envFiles: [env], profiles: [] }
    };
    const request = { version: 1, id, kind: "validate", generation: 1, sources: [
      { id: "app", contentHash: sha256(Buffer.from(currentApplication)), candidate: "app" },
      { id: "compose-override", contentHash: sha256(Buffer.from(currentOverride)), candidate: "compose-override" }
    ] };
    // collisions fail before either live or staged override bytes are changed
    if (scenario.collision) {
      await assert.rejects(validateRequest(descriptor, request), /project-mount-yaml-unsupported/);
      assert.equal(readFileSync(app, "utf8"), currentApplication);
      assert.equal(readFileSync(composeOverride, "utf8"), currentOverride);
      assert.equal(readFileSync(join(stage, "compose-override"), "utf8"), currentOverride);
      return;
    }
    // unsupported deferred merge keys must fail before commit publication
    if (scenario.rejection) {
      await assert.rejects(processOperation(descriptor, { ...request, kind: "commit" }), { code: scenario.unknownOwned ? "project-mount-transition-ambiguous" : "invalid-compose" });
      assert.equal(readFileSync(app, "utf8"), currentApplication);
      assert.equal(readFileSync(composeOverride, "utf8"), currentOverride);
      // ambiguous ownership is rejected before replacing even the private candidate
      if (scenario.unknownOwned) assert.equal(readFileSync(join(stage, "compose-override"), "utf8"), currentOverride);
      return;
    }
    await validateRequest(descriptor, request);
    const generated = readFileSync(join(stage, "compose-override"), "utf8");
    const validated = await validateComposeCandidates(descriptor, new Map([["app", join(stage, "app")], ["compose-override", join(stage, "compose-override")]]), stage, undefined, true);
    const volume = validated.resolvedModel.services["remote-agent-console"].volumes.find((entry) => posix.resolve(entry.target.replaceAll("$$", "$")) === posix.resolve(target));
    // empty repair removes only RAC-owned binds and retains manual bytes
    if (scenario.cleanup) {
      assert.equal(volume, undefined);
      assert.ok(generated.includes("- /manual/source:/manual/target:ro # operator mount"));
      assert.ok(!generated.includes(oldHostPath));
    } else {
      assert.ok(volume);
      assert.equal(volume.source.replaceAll("$$", "$"), hostPath);
      assert.equal(volume.read_only === true, legacy);
      assert.match(generated, /source: ".*\$\$cash \$\$\$\$double path"/);
    }
    const actual = JSON.parse(execFileSync("docker", [...composePrefix(descriptor.compose, [compose, join(stage, "compose-override")]), "config", "--format", "json"], { encoding: "utf8" }));
    const effective = actual.services["remote-agent-console"].volumes.find((entry) => posix.resolve(entry.target.replaceAll("$$", "$")) === posix.resolve(target));
    // both actual merge outcomes must agree with the staged planning view
    if (scenario.cleanup) assert.equal(effective, undefined);
    else {
      assert.equal(effective.source.replaceAll("$$", "$"), hostPath);
      assert.equal(effective.read_only === true, legacy);
    }
    assert.equal(readFileSync(app, "utf8"), currentApplication);
    assert.equal(readFileSync(composeOverride, "utf8"), currentOverride);
    // repeated derivation must retain the same merge key and owned bytes
    if (scenario.managed) {
      await validateRequest(descriptor, request);
      assert.equal(readFileSync(join(stage, "compose-override"), "utf8"), generated);
    }
    // exercise real publication while isolating the unrelated running-service proof
    if (scenario.commit) {
      mkdirSync(join(control, "recovery"), { mode: 0o700 });
      mkdirSync(join(control, "journal"), { mode: 0o700 });
      ensureRecoveryKey(control);
      const committed = await processOperation(descriptor, { ...request, kind: "commit" }, {
        // this fixture has no running container to attest a baseline
        baselineProve: async (_descriptor, target) => { assert.equal(target, "rac"); return {}; }
      });
      assert.equal(committed.phase, "committed");
      assert.equal(readFileSync(app, "utf8"), readFileSync(join(stage, "app"), "utf8"));
      assert.equal(readFileSync(composeOverride, "utf8"), generated);
      // cleanup intentionally removes owned bytes rather than the manual prefix
      if (scenario.cleanup) assert.ok(generated.includes("- /manual/source:/manual/target:ro # operator mount"));
      else assert.ok(generated.startsWith(currentOverride));
      assert.equal(committed.receipt.hashes.app, sha256(readFileSync(app)));
      assert.equal(committed.receipt.hashes["compose-override"], sha256(readFileSync(composeOverride)));
      assert.deepEqual(committed.receipt.targets, ["rac"]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
