import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import test from "node:test";
import { PROJECT_MOUNT_OPERATOR_VOLUMES, projectMountsChanged, synchronizeProjectMounts } from "./project-mounts.mjs";
import { composePrefix, validateComposeCandidates } from "./validate.mjs";
import { ensureRecoveryKey, processOperation, validateRequest } from "./operations.mjs";
import { sha256 } from "./crypto.mjs";
import { validateDescriptor } from "./contracts.mjs";
import { MAX_SOURCE_BYTES } from "./constants.mjs";

const override = `services:
  remote-agent-console:
    environment:
      EXISTING: yes
    volumes:
      - /manual/source:/manual/target:ro # operator mount
`;

const application = (projects) => `${JSON.stringify({ name: "RAC", projects }, null, 2)}\n`;
// distinguish the full mount model from an explicitly trusted operator-only projection
const model = (volumes = [], operatorVolumes) => ({ services: { "remote-agent-console": { volumes } }, ...(operatorVolumes !== undefined ? { [PROJECT_MOUNT_OPERATOR_VOLUMES]: operatorVolumes } : {}) });

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
  const result = synchronizeProjectMounts(owned, "{", application([]), model([{ type: "bind", source: "/host/old", target: "/old" }], []), "/stack");
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

// duplicate row multiplicity still represents one unambiguous effective transition
test("moves duplicate idless mappings once while inheriting their policy", () => {
  const old = { path: "/old", hostPath: "/host/old" };
  const next = { path: "/new", hostPath: "/host/new" };
  const result = synchronizeProjectMounts(override, application([old, old]), application([next, next]), model([{ type: "bind", source: old.hostPath, target: old.path, read_only: true }]), "/stack");
  assert.match(result, /target: "\/new"\n        read_only: true/);
  assert.equal(result.match(/target: "\/new"/gu)?.length, 1);
});

// invalid stable identities may be removed or retained exactly without guessing
for (const retain of [false, true]) test(`${retain ? "retains an exact row from" : "clears"} conflicting current stable IDs`, () => {
  const selected = [{ id: "same", path: "/one", hostPath: "/host/one" }, { id: "same", path: "/two", hostPath: "/host/two" }];
  const current = application(selected);
  const owned = synchronizeProjectMounts(override, application([]), current, model(), "/stack").replaceAll("read_only: false", "read_only: true");
  const result = synchronizeProjectMounts(owned, current, application(retain ? [selected[0]] : []), model(selected.map((entry) => ({ type: "bind", source: entry.hostPath, target: entry.path, read_only: true })), []), "/stack");
  assert.doesNotMatch(result, /target: "\/two"/);
  assert.ok(result.includes("- /manual/source:/manual/target:ro # operator mount"));
  // exact retention keeps only the selected row's own restrictive policy
  if (retain) assert.match(result, /target: "\/one"\n        read_only: true/);
  else assert.doesNotMatch(result, /target: "\/one"/);
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

const crossIdentityPolicyCases = [
  {
    name: "retains read-only policy when repairing a numeric ID and moving",
    current: { id: 42, path: "/old/numeric", hostPath: "/host/old/numeric" },
    candidate: { id: "repaired", path: "/new/numeric", hostPath: "/host/new/numeric" }
  },
  {
    name: "retains read-only policy when assigning an ID and moving",
    current: { path: "/old/idless", hostPath: "/host/old/idless" },
    candidate: { id: "assigned", path: "/new/idless", hostPath: "/host/new/idless" }
  },
  {
    name: "retains read-only policy when changing a stable ID and moving",
    current: { id: "before", path: "/old/stable", hostPath: "/host/old/stable" },
    candidate: { id: "after", path: "/new/stable", hostPath: "/host/new/stable" }
  }
];

// preserve policy across identity repairs
for (const scenario of crossIdentityPolicyCases) test(scenario.name, () => {
  const selected = model([{ type: "bind", source: scenario.current.hostPath, target: scenario.current.path, read_only: true }]);
  const result = synchronizeProjectMounts(override, application([scenario.current]), application([scenario.candidate]), selected, "/stack");
  assert.ok(result.includes(`target: ${JSON.stringify(scenario.candidate.path)}\n        read_only: true`));
});

test("regenerates and removes only stale owned mounts", () => {
  const current = application([{ id: "project", path: "/worktrees/old", hostPath: "/host/old" }]);
  const candidate = application([]);
  const owned = synchronizeProjectMounts(override, application([]), current, model(), "/stack");
  const result = synchronizeProjectMounts(owned, current, candidate, model([{ type: "bind", source: "/host/old", target: "/worktrees/old", read_only: false }], []), "/stack");
  assert.doesNotMatch(result, /\/host\/old|\/worktrees\/old/);
  assert.match(result, /- \/manual\/source:\/manual\/target:ro # operator mount/);
  assert.equal(synchronizeProjectMounts(owned, application([]), current, model([{ type: "bind", source: "/host/old", target: "/worktrees/old", read_only: false }], []), "/stack"), owned);
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

const ownedStart = "      # rac-project-mounts:start";
const ownedEnd = "      # rac-project-mounts:end";
const completeOwnedBind = `      - type: bind
        source: "/host/owned"
        target: "/owned"
        read_only: false
        bind:
          create_host_path: false
`;

const malformedOwnedBlocks = [
  { name: "duplicate start markers", source: `${override}${ownedStart}\n${ownedStart}\n${completeOwnedBind}${ownedEnd}\n` },
  { name: "duplicate end markers", source: `${override}${ownedStart}\n${completeOwnedBind}${ownedEnd}\n${ownedEnd}\n` },
  { name: "an orphan end marker", source: `${override}${ownedEnd}\n` },
  { name: "reversed markers", source: `${override}${ownedEnd}\n${ownedStart}\n` },
  { name: "markers outside the volumes region", source: `services:\n  remote-agent-console:\n${ownedStart}\n    volumes:\n${completeOwnedBind}${ownedEnd}\n` },
  { name: "a bind without a source", source: `${override}${ownedStart}\n      - type: bind\n        target: "/owned"\n${ownedEnd}\n` },
  { name: "a bind without a target", source: `${override}${ownedStart}\n      - type: bind\n        source: "/host/owned"\n${ownedEnd}\n` },
  { name: "duplicate source fields", source: `${override}${ownedStart}\n${completeOwnedBind.replace('        target: "/owned"\n', '        source: "/host/duplicate"\n        target: "/owned"\n')}${ownedEnd}\n` },
  { name: "duplicate target fields", source: `${override}${ownedStart}\n${completeOwnedBind.replace('        target: "/owned"\n', '        target: "/owned"\n        target: "/duplicate"\n')}${ownedEnd}\n` },
  { name: "a malformed source path escape", source: `${override}${ownedStart}\n${completeOwnedBind.replace('/host/owned', '/host/\\q')}${ownedEnd}\n` },
  { name: "a malformed target path escape", source: `${override}${ownedStart}\n${completeOwnedBind.replace('        target: "/owned"', '        target: "/target/\\q"')}${ownedEnd}\n` },
  { name: "an unexpected owned option", source: `${override}${ownedStart}\n${completeOwnedBind.replace('        read_only: false\n', '        read_only: false\n        unexpected: true\n')}${ownedEnd}\n` }
];

// exercise every owned-block rejection shape
for (const malformed of malformedOwnedBlocks) test(`rejects malformed ownership block with ${malformed.name}`, () => {
  const candidate = application([{ id: "project", path: "/new", hostPath: "/host/new" }]);
  assert.throws(() => synchronizeProjectMounts(malformed.source, application([]), candidate, model(), "/stack"), /project-mount-marker-invalid/);
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
  const result = synchronizeProjectMounts(owned, application([legacy]), application([legacy, { id: "new", path: "/new", hostPath: "/host/new" }]), model([{ type: "bind", source: "/host/old", target: "/same", read_only: true }], []), "/stack");
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

const projectMountContract = JSON.parse(readFileSync(new URL("./project-mount-contract.json", import.meta.url), "utf8"));

// serialize one corpus application
function contractApplication(state) {
  return `${JSON.stringify({ ...projectMountContract.applicationDefaults, ...state })}\n`;
}

// projection-contract changes update this corpus
for (const vector of projectMountContract.vectors) test(`matches project mount projection contract: ${vector.name}`, () => {
  // preserve damaged current bytes exactly
  const current = typeof vector.current === "string" ? vector.current : contractApplication(vector.current);
  const candidate = contractApplication(vector.candidate);
  assert.equal(projectMountsChanged(current, candidate, vector.hasOverride), vector.changed);
});

test("rejects candidate Project IDs that are not strings", () => {
  const candidate = application([{ id: 42, path: "/candidate" }]);
  assert.throws(() => projectMountsChanged(application([]), candidate), /invalid-project-mounts/);
});

// keep explicit candidate null strict
test("rejects a null candidate Project collection", () => {
  assert.throws(() => projectMountsChanged(application([]), application(null)), /invalid-project-mounts/);
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

// managed children must not hide a newly restrictive operator ancestor
test("regenerates a writable owned child under a read-only operator ancestor as read-only", () => {
  const project = { id: "owned", path: "/tree/child", hostPath: "/host/child" };
  const current = application([project]);
  const owned = synchronizeProjectMounts(override, application([]), current, model(), "/stack");
  const candidate = application([project, { id: "other", path: "/other", hostPath: "/host/other" }]);
  const ancestor = { type: "bind", source: "/operator/tree", target: "/tree", read_only: true };
  const result = synchronizeProjectMounts(owned, current, candidate, model([
    ancestor,
    { type: "bind", source: "/host/child", target: "/tree/child", read_only: false }
  ], [ancestor]), "/stack");
  assert.match(result, /target: "\/tree\/child"\n        read_only: true/);
});

// moving a managed child retains the previous operator-only access boundary
test("inherits the old operator read-only boundary when a writable owned child moves away", () => {
  const project = { id: "owned", path: "/tree/child", hostPath: "/host/child" };
  const current = application([project]);
  const owned = synchronizeProjectMounts(override, application([]), current, model(), "/stack");
  const ancestor = { type: "bind", source: "/operator/tree", target: "/tree", read_only: true };
  const result = synchronizeProjectMounts(owned, current, application([{ ...project, path: "/outside", hostPath: "/host/new" }]), model([ancestor, { type: "bind", source: project.hostPath, target: project.path, read_only: false }], [ancestor]), "/stack");
  assert.match(result, /target: "\/outside"\n        read_only: true/);
});

// matching host sources cannot bypass a previous read-only policy
test("overlays a matching writable destination when a read-only Project moves there", () => {
  const result = synchronizeProjectMounts(override, application([{ id: "project", path: "/old", hostPath: "/host/old" }]), application([{ id: "project", path: "/new", hostPath: "/host/new" }]), model([
    { type: "bind", source: "/host/old", target: "/old", read_only: true },
    { type: "bind", source: "/host/new", target: "/new", read_only: false }
  ]), "/stack");
  assert.match(result, /target: "\/new"\n        read_only: true/);
});

// removing an owned child must not expose a matching but less restrictive ancestor
test("retains an owned read-only child when its writable ancestor already covers the source", () => {
  const project = { id: "owned", path: "/tree/child", hostPath: "/host/tree/child" };
  const current = application([project]);
  const owned = synchronizeProjectMounts(override, application([]), current, model([{ type: "bind", source: "/elsewhere", target: project.path, read_only: true }]), "/stack");
  const ancestor = { type: "bind", source: "/host/tree", target: "/tree", read_only: false };
  const result = synchronizeProjectMounts(owned, current, application([project, { id: "other", path: "/other", hostPath: "/host/other" }]), model([ancestor, { type: "bind", source: project.hostPath, target: project.path, read_only: true }], [ancestor]), "/stack");
  assert.match(result, /target: "\/tree\/child"\n        read_only: true/);
});

// an already-correct source still needs the Project's explicit inherited options
test("overlays a matching destination to retain explicit prior bind options", () => {
  const result = synchronizeProjectMounts(override, application([{ id: "project", path: "/old", hostPath: "/host/old" }]), application([{ id: "project", path: "/new", hostPath: "/host/new" }]), model([
    { type: "bind", source: "/host/old", target: "/old", bind: { propagation: "rprivate" } },
    { type: "bind", source: "/host/new", target: "/new", bind: { propagation: "rshared" } }
  ]), "/stack");
  assert.match(result, /target: "\/new"[\s\S]*propagation: "rprivate"/);
});

// complete group policy must be checked before the matching-source fast path
test("rejects coalesced option conflicts even when an operator mount covers the source", () => {
  const current = application([{ id: "one", path: "/old/one", hostPath: "/host/one" }, { id: "two", path: "/old/two", hostPath: "/host/two" }]);
  const next = application([{ id: "one", path: "/same", hostPath: "/host/same" }, { id: "two", path: "/same", hostPath: "/host/same" }]);
  assert.throws(() => synchronizeProjectMounts(override, current, next, model([
    { type: "bind", source: "/host/one", target: "/old/one", bind: { propagation: "rprivate" } },
    { type: "bind", source: "/host/two", target: "/old/two", bind: { propagation: "rshared" } },
    { type: "bind", source: "/host/same", target: "/same" }
  ]), "/stack"), /project-mount-transition-ambiguous/);
});

// owned blocks require provenance rather than an incomplete filtered-model fallback
test("rejects managed regeneration without an operator-only projection", () => {
  const current = application([{ id: "owned", path: "/old", hostPath: "/host/old" }]);
  const owned = synchronizeProjectMounts(override, application([]), current, model(), "/stack");
  assert.throws(() => synchronizeProjectMounts(owned, current, application([]), model(), "/stack"), /invalid-project-mount-model/);
});

// present but malformed private projections must not fall back to weaker policy
for (const value of [undefined, null, {}]) test(`rejects a malformed operator-only projection ${JSON.stringify(value)}`, () => {
  const current = application([{ id: "owned", path: "/old", hostPath: "/host/old" }]);
  const owned = synchronizeProjectMounts(override, application([]), current, model(), "/stack");
  const selected = { ...model(), [PROJECT_MOUNT_OPERATOR_VOLUMES]: value };
  assert.throws(() => synchronizeProjectMounts(owned, current, application([]), selected, "/stack"), /invalid-project-mount-model/);
});

// canonical group ownership must not depend on which alias appears last
for (const reverse of [false, true]) test(`generates a new canonical alias with legacy row ${reverse ? "first" : "last"}`, () => {
  const legacy = { id: "legacy", path: "/child/../same", hostPath: "/host/same" };
  const canonical = { id: "new", path: "/same", hostPath: "/host/same" };
  const result = synchronizeProjectMounts(override, application([legacy]), application(reverse ? [legacy, canonical] : [canonical, legacy]), model(), "/stack");
  assert.match(result, /source: "\/host\/same"\n        target: "\/same"/);
  assert.equal(result.match(/target: "\/same"/gu)?.length, 1);
});

// coalescing two transitions must retain the most restrictive prior access policy
for (const reverse of [false, true]) test(`retains read-only policy when coalescing transitions in ${reverse ? "reverse" : "forward"} order`, () => {
  const current = application([{ id: "read-only", path: "/old/ro", hostPath: "/host/ro" }, { id: "writable", path: "/old/rw", hostPath: "/host/rw" }]);
  const next = [{ id: "read-only", path: "/same", hostPath: "/host/same" }, { id: "writable", path: "/same", hostPath: "/host/same" }];
  const result = synchronizeProjectMounts(override, current, application(reverse ? next.toReversed() : next), model([
    { type: "bind", source: "/host/ro", target: "/old/ro", read_only: true },
    { type: "bind", source: "/host/rw", target: "/old/rw", read_only: false }
  ]), "/stack");
  assert.match(result, /target: "\/same"\n        read_only: true/);
  assert.equal(result.match(/target: "\/same"/gu)?.length, 1);
});

// non-read-only option conflicts cannot be resolved by presentation order
for (const option of ["propagation", "consistency"]) for (const reverse of [false, true]) test(`rejects coalesced ${option} disagreement in ${reverse ? "reverse" : "forward"} order`, () => {
  const current = application([{ id: "one", path: "/old/one", hostPath: "/host/one" }, { id: "two", path: "/old/two", hostPath: "/host/two" }]);
  const next = [{ id: "one", path: "/same", hostPath: "/host/same" }, { id: "two", path: "/same", hostPath: "/host/same" }];
  const first = option === "propagation" ? { bind: { propagation: "rshared" } } : { consistency: "cached" };
  const second = option === "propagation" ? { bind: { propagation: "rprivate" } } : { consistency: "delegated" };
  assert.throws(() => synchronizeProjectMounts(override, current, application(reverse ? next.toReversed() : next), model([
    { type: "bind", source: "/host/one", target: "/old/one", ...first },
    { type: "bind", source: "/host/two", target: "/old/two", ...second }
  ]), "/stack"), /project-mount-transition-ambiguous/);
});

// equivalent policies ignore map order and the forced safe path-creation flag
for (const reverse of [false, true]) test(`coalesces agreeing options in ${reverse ? "reverse" : "forward"} order`, () => {
  const current = application([{ id: "one", path: "/old/one", hostPath: "/host/one" }, { id: "two", path: "/old/two", hostPath: "/host/two" }]);
  const next = [{ id: "one", path: "/same", hostPath: "/host/same" }, { id: "two", path: "/same", hostPath: "/host/same" }];
  const result = synchronizeProjectMounts(override, current, application(reverse ? next.toReversed() : next), model([
    { type: "bind", source: "/host/one", target: "/old/one", read_only: true, consistency: "cached", bind: { propagation: "rprivate", selinux: "z", create_host_path: true } },
    { type: "bind", source: "/host/two", target: "/old/two", consistency: "cached", bind: { selinux: "z", create_host_path: false, propagation: "rprivate" } }
  ]), "/stack");
  assert.match(result, /target: "\/same"\n        read_only: true\n        consistency: "cached"\n        bind:\n          propagation: "rprivate"\n          selinux: "z"\n          create_host_path: false/);
});

// a newly added group member cannot erase an existing member's agreeing policy
test("inherits transition options when a new Project is the canonical representative", () => {
  const current = application([{ id: "existing", path: "/old", hostPath: "/host/old" }]);
  const next = application([{ id: "new", path: "/same", hostPath: "/host/same" }, { id: "existing", path: "/same", hostPath: "/host/same" }]);
  const result = synchronizeProjectMounts(override, current, next, model([{ type: "bind", source: "/host/old", target: "/old", bind: { propagation: "rprivate" } }]), "/stack");
  assert.match(result, /target: "\/same"[\s\S]*propagation: "rprivate"/);
});

// unchanged owned members keep a vote when another Project joins their destination
test("rejects an option conflict between a retained owned member and an incoming transition", () => {
  const retained = { id: "retained", path: "/same", hostPath: "/host/same" };
  const incoming = { id: "incoming", path: "/old", hostPath: "/host/old" };
  const owned = synchronizeProjectMounts(override, application([]), application([retained]), model(), "/stack").replace("          create_host_path: false", '          propagation: "rprivate"\n          create_host_path: false');
  const oldIncoming = { type: "bind", source: incoming.hostPath, target: incoming.path, bind: { propagation: "rshared" } };
  const selected = model([{ type: "bind", source: retained.hostPath, target: retained.path, bind: { propagation: "rprivate" } }, oldIncoming], [oldIncoming]);
  assert.throws(() => synchronizeProjectMounts(owned, application([retained, incoming]), application([retained, { ...incoming, path: retained.path, hostPath: retained.hostPath }]), selected, "/stack"), /project-mount-transition-ambiguous/);
});

// inherited mapping keys are outside the byte-preserving editor's supported grammar
for (const merge of ["<<: *defaults", '"<<": *defaults', "'<<': *defaults", "? <<"]) test(`rejects inherited service volumes through ${merge}`, () => {
  const source = `x-defaults: &defaults\n  volumes: []\nservices:\n  remote-agent-console:\n    ${merge}\n`;
  assert.throws(() => synchronizeProjectMounts(source, application([]), application([{ id: "new", path: "/new", hostPath: "/host/new" }]), model(), "/stack"), /project-mount-yaml-unsupported/);
});

// exercise real compose parsing without creating containers or changing live sources
const composeCaseId = "project_mounts_case_0001";
const emptyComposeOverride = "services:\n  remote-agent-console:\n    volumes:\n";
const manualComposeOverride = `${emptyComposeOverride}      - /manual/source:/manual/target:ro # operator mount\n`;
const literalDollarTarget = "/worktrees/$cash $$double path";
const legacyTarget = "/child/../same";

// pad one compose override exactly
function composeOverrideWithByteLength(size) {
  const line = "      # source-size-padding\n";
  const available = size - Buffer.byteLength(emptyComposeOverride);
  const completeLines = Math.floor(available / Buffer.byteLength(line));
  const source = `${emptyComposeOverride}${line.repeat(completeLines)}`;
  return `${source}${"#".repeat(size - Buffer.byteLength(source))}`;
}

// format one serializer-owned bind
function longFormBind(source, target, readOnly = true) {
  return `      - type: bind\n        source: ${JSON.stringify(source)}\n        target: ${JSON.stringify(target)}\n        read_only: ${readOnly}\n`;
}

// require the real compose cli
function requireRealCompose(context) {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
  } catch {
    // skip a missing integration dependency
    context.skip("Docker Compose unavailable");
    return false;
  }
  return true;
}

// create private case paths
function createRealComposePaths() {
  const root = mkdtempSync(join(tmpdir(), "rac-project-mounts-"));
  chmodSync(root, 0o700);
  const control = join(root, "control");
  const stage = join(control, "staging", composeCaseId);
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  return {
    root,
    control,
    stage,
    app: join(root, "config.json"),
    env: join(root, ".env"),
    compose: join(root, "compose.yaml"),
    composeOverride: join(root, "compose.override.yaml")
  };
}

// write and validate one installation
function initializeRealComposeCase(paths, currentApplication, currentOverride, envTarget) {
  writeFileSync(paths.app, currentApplication);
  writeFileSync(paths.env, `RAC_TEST_TARGET=${envTarget}\n`);
  writeFileSync(paths.compose, `services:\n  remote-agent-console:\n    image: alpine\n    healthcheck:\n      test: ["CMD", "true"]\n    environment:\n      RAC_CONFIG: /workspace/config.json\n      RAC_CONFIG_WRITE_PATH: /workspace/config.json\n      RAC_SERVER_CHECKOUT: /workspace\n      RAC_PASSWORD_HASH: $$argon2id$$fixture\n      RAC_SESSION_SECRET: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n    volumes:\n      - type: bind\n        source: ${JSON.stringify(paths.root)}\n        target: /workspace\n      - type: bind\n        source: ${JSON.stringify(paths.control)}\n        target: /run/rac-settings-control\n`);
  writeFileSync(paths.composeOverride, currentOverride);
  const descriptorValue = {
    version: 1,
    installationId: "project-mount-test-0001",
    generation: 1,
    uid: process.getuid(),
    gid: process.getgid(),
    kind: "compose",
    hostControlRoot: paths.control,
    hostCheckout: paths.root,
    serverCheckout: "/workspace",
    allowedRoots: [paths.root],
    sources: {
      app: { path: paths.app, serverPath: "/workspace/config.json", kind: "json", apply: "rac-restart" },
      env: { path: paths.env, kind: "env", apply: "rac-restart" },
      compose: { path: paths.compose, kind: "compose", apply: "rac-restart" },
      "compose-override": { path: paths.composeOverride, kind: "compose", apply: "rac-restart" }
    },
    compose: { projectDirectory: paths.root, projectName: "project-mounts", files: [paths.compose, paths.composeOverride], envFiles: [paths.env], profiles: [] }
  };
  const descriptorPath = join(paths.control, "installation.json");
  writeFileSync(descriptorPath, `${JSON.stringify(descriptorValue)}\n`);
  return {
    ...paths,
    currentApplication,
    currentOverride,
    descriptor: validateDescriptor(descriptorValue, descriptorPath)
  };
}

// stage one app and override request
function stageRealComposeCase(current, candidateProjects) {
  writeFileSync(join(current.stage, "app"), application(candidateProjects));
  writeFileSync(join(current.stage, "compose-override"), current.currentOverride);
  return {
    version: 1,
    id: composeCaseId,
    kind: "validate",
    generation: 1,
    sources: [
      { id: "app", contentHash: sha256(Buffer.from(current.currentApplication)), candidate: "app" },
      { id: "compose-override", contentHash: sha256(Buffer.from(current.currentOverride)), candidate: "compose-override" }
    ]
  };
}

// find one canonical container target
function volumeForTarget(composeModel, target) {
  // compare normalized target spellings
  return composeModel.services["remote-agent-console"].volumes.find((entry) => posix.resolve(entry.target.replaceAll("$$", "$")) === posix.resolve(target));
}

// query actual compose output
function queryActualComposeModel(current, overridePath) {
  return JSON.parse(execFileSync("docker", [...composePrefix(current.descriptor.compose, [current.compose, overridePath]), "config", "--format", "json"], { encoding: "utf8" }));
}

// observe planned and actual models
async function validateAndObserveRealCompose(current, request) {
  await validateRequest(current.descriptor, request);
  const generated = readFileSync(join(current.stage, "compose-override"), "utf8");
  const validated = await validateComposeCandidates(current.descriptor, new Map([
    ["app", join(current.stage, "app")],
    ["compose-override", join(current.stage, "compose-override")]
  ]), current.stage, undefined, true);
  const actual = queryActualComposeModel(current, join(current.stage, "compose-override"));
  return { generated, planned: validated.resolvedModel, actual };
}

// assert live authority stayed exact
function assertLiveComposeBytesUnchanged(current) {
  assert.equal(readFileSync(current.app, "utf8"), current.currentApplication);
  assert.equal(readFileSync(current.composeOverride, "utf8"), current.currentOverride);
}

// assert private override stayed exact
function assertStagedOverrideUnchanged(current) {
  assert.equal(readFileSync(join(current.stage, "compose-override"), "utf8"), current.currentOverride);
}

// commit through the isolated baseline seam
async function commitRealComposeCase(current, request) {
  mkdirSync(join(current.control, "recovery"), { mode: 0o700 });
  mkdirSync(join(current.control, "journal"), { mode: 0o700 });
  ensureRecoveryKey(current.control);
  return processOperation(current.descriptor, { ...request, kind: "commit" }, {
    // accept the isolated rac baseline
    baselineProve: async (_descriptor, target) => {
      assert.equal(target, "rac");
      return {};
    }
  });
}

// remove one private case
function removeRealComposeCase(current) {
  rmSync(current.root, { recursive: true, force: true });
}

const mergeSpellingCases = [
  { name: "literal dollar paths", style: "none" },
  { name: "short legacy source corrections", style: "short" },
  { name: "long legacy source corrections", style: "long" },
  { name: "repeated managed long-form corrections", style: "long", managedReadOnly: true },
  { name: "operator read-only policy over an old writable owned bind", style: "long", managedReadOnly: false },
  { name: "distinct authored long-form spelling", style: "long", authoredTarget: "/operator/../same" }
];

// exercise one merge-spelling success
async function exerciseMergeSpellingCase(context, scenario) {
  // stop when compose is unavailable
  if (!requireRealCompose(context)) return;
  const paths = createRealComposePaths();
  // always remove private inputs
  try {
    const hostPath = join(paths.root, "host $cash $$double path");
    const oldHostPath = join(paths.root, "host-old");
    const target = scenario.style === "none" ? literalDollarTarget : legacyTarget;
    const authoredTarget = scenario.authoredTarget ?? target;
    const currentApplication = scenario.style === "none"
      ? application([])
      : application([{ id: "project", path: target, hostPath: oldHostPath }]);
    let currentOverride = emptyComposeOverride;
    // retain the selected operator spelling
    if (scenario.style !== "none") {
      const operatorMount = longFormBind(oldHostPath, authoredTarget);
      currentOverride += scenario.style === "short" ? `      - ${oldHostPath}:${authoredTarget}:ro\n` : operatorMount;
      // retain an independently owned policy
      if (scenario.managedReadOnly !== undefined) {
        currentOverride += `${ownedStart}\n${longFormBind(oldHostPath, authoredTarget, scenario.managedReadOnly)}${ownedEnd}\n`;
      }
    }
    const current = initializeRealComposeCase(paths, currentApplication, currentOverride, target);
    const request = stageRealComposeCase(current, [{ id: "project", path: target, hostPath }]);
    const observed = await validateAndObserveRealCompose(current, request);
    const planned = volumeForTarget(observed.planned, target);
    assert.ok(planned);
    assert.equal(planned.source.replaceAll("$$", "$"), hostPath);
    assert.equal(planned.read_only === true, scenario.style !== "none");
    assert.match(observed.generated, /source: ".*\$\$cash \$\$\$\$double path"/);
    const actual = volumeForTarget(observed.actual, target);
    assert.ok(actual);
    assert.equal(actual.source.replaceAll("$$", "$"), hostPath);
    assert.equal(actual.read_only === true, scenario.style !== "none");
    assertLiveComposeBytesUnchanged(current);
    // prove managed regeneration is idempotent
    if (scenario.managedReadOnly !== undefined) {
      await validateRequest(current.descriptor, request);
      assert.equal(readFileSync(join(current.stage, "compose-override"), "utf8"), observed.generated);
    }
  } finally {
    removeRealComposeCase(paths);
  }
}

// register flat merge-spelling tests
for (const scenario of mergeSpellingCases) test(`validates ${scenario.name} through real Compose`, async (context) => {
  await exerciseMergeSpellingCase(context, scenario);
});

const publicationCases = [
  { name: "committed long-form source corrections", kind: "correction" },
  { name: "numeric current ID repaired and moved from operator read-only", kind: "identity-repair" },
  { name: "committed empty repair with owned mount cleanup", kind: "cleanup" },
  { name: "committed null Project collection cleanup with owned mount removal", kind: "null-cleanup" },
  { name: "conflicting IDs cleared with owned mounts", kind: "clear" },
  { name: "an exact row retained from conflicting IDs", kind: "retain" }
];

// exercise one committed publication
async function exercisePublicationCase(context, scenario) {
  // stop when compose is unavailable
  if (!requireRealCompose(context)) return;
  const paths = createRealComposePaths();
  // always remove private inputs
  try {
    const hostPath = join(paths.root, "host $cash $$double path");
    const oldHostPath = join(paths.root, "host-old");
    const repairProjects = [
      { id: "same", path: "/one", hostPath: oldHostPath },
      { id: "same", path: "/two", hostPath: `${oldHostPath}-two` }
    ];
    let currentApplication;
    let currentOverride;
    let candidateProjects;
    let expectedTarget;
    let expectedSource;
    let emptyRepair = false;
    let damagedIdRepair = false;
    // build the ordinary long-form correction
    if (scenario.kind === "correction") {
      currentApplication = application([{ id: "project", path: legacyTarget, hostPath: oldHostPath }]);
      currentOverride = `${emptyComposeOverride}${longFormBind(oldHostPath, legacyTarget)}`;
      candidateProjects = [{ id: "project", path: legacyTarget, hostPath }];
      expectedTarget = legacyTarget;
      expectedSource = hostPath;
    // build the numeric-id repair
    } else if (scenario.kind === "identity-repair") {
      currentApplication = application([{ id: 42, path: legacyTarget, hostPath: oldHostPath }]);
      currentOverride = `${emptyComposeOverride}${longFormBind(oldHostPath, legacyTarget)}`;
      candidateProjects = [{ id: "repaired", path: "/identity/repaired", hostPath }];
      expectedTarget = candidateProjects[0].path;
      expectedSource = hostPath;
    // build one damaged empty cleanup
    } else if (["cleanup", "null-cleanup"].includes(scenario.kind)) {
      currentApplication = scenario.kind === "null-cleanup" ? application(null) : "{";
      currentOverride = `${manualComposeOverride}${ownedStart}\n${longFormBind(oldHostPath, legacyTarget)}${ownedEnd}\n`;
      candidateProjects = [];
      expectedTarget = legacyTarget;
      emptyRepair = true;
    // build one damaged-id repair
    } else {
      currentApplication = application(repairProjects);
      currentOverride = `${emptyComposeOverride}      - /manual/source:/manual/target:ro # operator mount\n${ownedStart}\n${longFormBind(repairProjects[0].hostPath, repairProjects[0].path)}${longFormBind(repairProjects[1].hostPath, repairProjects[1].path)}${ownedEnd}\n`;
      candidateProjects = scenario.kind === "retain" ? [repairProjects[0]] : [];
      expectedTarget = repairProjects[0].path;
      expectedSource = oldHostPath;
      emptyRepair = scenario.kind === "clear";
      damagedIdRepair = true;
    }
    const current = initializeRealComposeCase(paths, currentApplication, currentOverride, legacyTarget);
    const request = stageRealComposeCase(current, candidateProjects);
    const observed = await validateAndObserveRealCompose(current, request);
    const planned = volumeForTarget(observed.planned, expectedTarget);
    // verify owned cleanup without manual-byte loss
    if (emptyRepair) {
      assert.equal(planned, undefined);
      assert.ok(observed.generated.includes("- /manual/source:/manual/target:ro # operator mount"));
      assert.ok(!observed.generated.includes(oldHostPath));
    } else {
      assert.ok(planned);
      assert.equal(planned.source.replaceAll("$$", "$"), expectedSource);
      assert.equal(planned.read_only === true, true);
      // retain literal-dollar publication coverage
      if (!damagedIdRepair) assert.match(observed.generated, /source: ".*\$\$cash \$\$\$\$double path"/);
    }
    const actual = volumeForTarget(observed.actual, expectedTarget);
    // compare actual cleanup or publication
    if (emptyRepair) {
      assert.equal(actual, undefined);
    } else {
      assert.ok(actual);
      assert.equal(actual.source.replaceAll("$$", "$"), expectedSource);
      assert.equal(actual.read_only === true, true);
    }
    // remove the discarded damaged sibling
    if (damagedIdRepair) {
      // compare each actual target
      assert.equal(observed.actual.services["remote-agent-console"].volumes.some((entry) => entry.target === repairProjects[1].path), false);
    }
    assertLiveComposeBytesUnchanged(current);
    const committed = await commitRealComposeCase(current, request);
    assert.equal(committed.phase, "committed");
    assert.equal(readFileSync(current.app, "utf8"), readFileSync(join(current.stage, "app"), "utf8"));
    assert.equal(readFileSync(current.composeOverride, "utf8"), observed.generated);
    // distinguish correction from repair bytes
    if (["correction", "identity-repair"].includes(scenario.kind)) assert.ok(observed.generated.startsWith(currentOverride));
    else assert.ok(observed.generated.includes("- /manual/source:/manual/target:ro # operator mount"));
    assert.equal(committed.receipt.hashes.app, sha256(readFileSync(current.app)));
    assert.equal(committed.receipt.hashes["compose-override"], sha256(readFileSync(current.composeOverride)));
    assert.deepEqual(committed.receipt.targets, ["rac"]);
    // verify repaired policy persisted live
    if (scenario.kind === "identity-repair") {
      const persisted = volumeForTarget(queryActualComposeModel(current, current.composeOverride), expectedTarget);
      assert.ok(persisted);
      assert.equal(persisted.source.replaceAll("$$", "$"), expectedSource);
      assert.equal(persisted.read_only === true, true);
    }
    // prove explicit-null cleanup persisted
    if (scenario.kind === "null-cleanup") {
      const persistedOverride = readFileSync(current.composeOverride, "utf8");
      assert.equal(persistedOverride.slice(0, manualComposeOverride.length), manualComposeOverride);
      assert.ok(!persistedOverride.includes(oldHostPath));
      assert.equal(volumeForTarget(queryActualComposeModel(current, current.composeOverride), expectedTarget), undefined);
    }
  } finally {
    removeRealComposeCase(paths);
  }
}

// register flat publication tests
for (const scenario of publicationCases) test(`validates ${scenario.name} through real Compose`, async (context) => {
  await exercisePublicationCase(context, scenario);
});

const authorityRejectionCases = [
  { name: "unknown owned transition without publication", kind: "unknown-owned", code: "project-mount-transition-ambiguous", preserveCandidate: true },
  { name: "inherited service volumes without publication", kind: "service-merge", code: "project-mount-yaml-unsupported", preserveCandidate: true },
  { name: "inherited services map without publication", kind: "services-merge", code: "project-mount-yaml-unsupported", preserveCandidate: true },
  // normalized target collisions fail in Compose before metadata inspection
  { name: "colliding literal long-form target spellings without publication", kind: "literal-collision", code: "invalid-compose", preserveCandidate: true },
  { name: "an ambiguous move from conflicting IDs", kind: "ambiguous-move", code: "project-mount-transition-ambiguous", preserveCandidate: true },
  { name: "ambiguous cross-identity moves without publication", kind: "ambiguous-cross-identity", code: "project-mount-transition-ambiguous", preserveCandidate: true },
  { name: "unsupported interpolated long-form corrections", kind: "interpolated", code: "invalid-compose", preserveCandidate: false }
];

// exercise one authority rejection
async function exerciseAuthorityRejectionCase(context, scenario) {
  // stop when compose is unavailable
  if (!requireRealCompose(context)) return;
  const paths = createRealComposePaths();
  // always remove private inputs
  try {
    const hostPath = join(paths.root, "host $cash $$double path");
    const oldHostPath = join(paths.root, "host-old");
    const repairProjects = [
      { id: "same", path: "/one", hostPath: oldHostPath },
      { id: "same", path: "/two", hostPath: `${oldHostPath}-two` }
    ];
    let currentApplication;
    let currentOverride;
    let candidateProjects;
    let envTarget = literalDollarTarget;
    // build unknown-owned authority
    if (scenario.kind === "unknown-owned") {
      currentApplication = "{";
      currentOverride = `${emptyComposeOverride}      - /manual/source:/manual/target:ro # operator mount\n${ownedStart}\n${longFormBind(oldHostPath, legacyTarget)}${ownedEnd}\n`;
      candidateProjects = [{ id: "project", path: "/new", hostPath }];
      envTarget = legacyTarget;
    // build a service-level merge
    } else if (scenario.kind === "service-merge") {
      currentApplication = application([]);
      currentOverride = 'x-defaults: &defaults\n  volumes:\n    - /manual/source:/manual/target:ro # operator mount\nservices:\n  remote-agent-console:\n    <<: *defaults\n';
      candidateProjects = [{ id: "project", path: literalDollarTarget, hostPath }];
    // build a services-map merge
    } else if (scenario.kind === "services-merge") {
      currentApplication = application([]);
      currentOverride = 'x-defaults: &defaults\n  remote-agent-console:\n    environment:\n      MANUAL_SENTINEL: kept\n    volumes:\n      - /manual/source:/manual/target:ro # operator mount\nservices:\n  <<: *defaults\n';
      candidateProjects = [{ id: "project", path: literalDollarTarget, hostPath }];
    // build colliding literal merge spellings
    } else if (scenario.kind === "literal-collision") {
      currentApplication = application([]);
      currentOverride = `${emptyComposeOverride}${longFormBind(oldHostPath, "/child/../same")}${longFormBind(hostPath, "/same")}`;
      candidateProjects = [{ id: "project", path: literalDollarTarget, hostPath }];
    // build a damaged-id move
    } else if (scenario.kind === "ambiguous-move") {
      currentApplication = application(repairProjects);
      currentOverride = `${emptyComposeOverride}      - /manual/source:/manual/target:ro # operator mount\n${ownedStart}\n${longFormBind(repairProjects[0].hostPath, repairProjects[0].path)}${longFormBind(repairProjects[1].hostPath, repairProjects[1].path)}${ownedEnd}\n`;
      candidateProjects = [{ id: "same", path: "/new", hostPath }];
    // build ambiguous cross-identity moves
    } else if (scenario.kind === "ambiguous-cross-identity") {
      currentApplication = application([
        { id: "old-one", path: "/old/one", hostPath: join(paths.root, "old-one") },
        { id: "old-two", path: "/old/two", hostPath: join(paths.root, "old-two") }
      ]);
      currentOverride = `${emptyComposeOverride}${longFormBind(join(paths.root, "old-one"), "/old/one")}${longFormBind(join(paths.root, "old-two"), "/old/two", false)}`;
      candidateProjects = [
        { id: "new-one", path: "/new/one", hostPath: join(paths.root, "new-one") },
        { id: "new-two", path: "/new/two", hostPath: join(paths.root, "new-two") }
      ];
    // build an unsupported interpolated target
    } else {
      currentApplication = application([{ id: "project", path: legacyTarget, hostPath: oldHostPath }]);
      currentOverride = `${emptyComposeOverride}      - type: bind\n        source: ${JSON.stringify(oldHostPath)}\n        target: \${RAC_TEST_TARGET}\n        read_only: true\n`;
      candidateProjects = [{ id: "project", path: legacyTarget, hostPath }];
      envTarget = legacyTarget;
    }
    const current = initializeRealComposeCase(paths, currentApplication, currentOverride, envTarget);
    const request = stageRealComposeCase(current, candidateProjects);
    await assert.rejects(processOperation(current.descriptor, { ...request, kind: "commit" }), { code: scenario.code });
    assertLiveComposeBytesUnchanged(current);
    // preserve candidates for authority failures only
    if (scenario.preserveCandidate) assertStagedOverrideUnchanged(current);
    // preserve the rejected staged application
    if (["ambiguous-cross-identity", "literal-collision"].includes(scenario.kind)) {
      assert.equal(readFileSync(join(current.stage, "app"), "utf8"), application(candidateProjects));
    }
  } finally {
    removeRealComposeCase(paths);
  }
}

// register flat authority rejection tests
for (const scenario of authorityRejectionCases) test(`rejects ${scenario.name} through real Compose`, async (context) => {
  await exerciseAuthorityRejectionCase(context, scenario);
});

const metadataCollisionCases = [
  { name: "unquoted metadata collision", key: "x-rac-project-mount-source" },
  { name: "double-quoted metadata collision", key: '"x-rac-project-mount-source"' },
  { name: "single-quoted metadata collision", key: "'x-rac-project-mount-source'" }
];

// exercise one reserved metadata collision
async function exerciseMetadataCollisionCase(context, scenario) {
  // stop when compose is unavailable
  if (!requireRealCompose(context)) return;
  const paths = createRealComposePaths();
  // always remove private inputs
  try {
    const hostPath = join(paths.root, "host $cash $$double path");
    const currentApplication = application([]);
    const currentOverride = `${emptyComposeOverride}${scenario.key}: {}\n`;
    const current = initializeRealComposeCase(paths, currentApplication, currentOverride, literalDollarTarget);
    const request = stageRealComposeCase(current, [{ id: "project", path: literalDollarTarget, hostPath }]);
    await assert.rejects(validateRequest(current.descriptor, request), /project-mount-yaml-unsupported/);
    assertLiveComposeBytesUnchanged(current);
    assertStagedOverrideUnchanged(current);
  } finally {
    removeRealComposeCase(paths);
  }
}

// register flat collision tests
for (const scenario of metadataCollisionCases) test(`validates ${scenario.name} through real Compose`, async (context) => {
  await exerciseMetadataCollisionCase(context, scenario);
});

// prove compose-valid orphan rejection is nonmutating
test("rejects an orphan owned end without publication through real Compose", async (context) => {
  // stop when compose is unavailable
  if (!requireRealCompose(context)) return;
  const paths = createRealComposePaths();
  // always remove private inputs
  try {
    const hostPath = join(paths.root, "host $cash $$double path");
    const currentApplication = application([]);
    const currentOverride = `${emptyComposeOverride}      - /manual/source:/manual/target:ro # operator mount\n${ownedEnd}\n`;
    const current = initializeRealComposeCase(paths, currentApplication, currentOverride, literalDollarTarget);
    const request = stageRealComposeCase(current, [{ id: "project", path: literalDollarTarget, hostPath }]);
    const actual = queryActualComposeModel(current, current.composeOverride);
    assert.ok(volumeForTarget(actual, "/manual/target"));
    await assert.rejects(processOperation(current.descriptor, { ...request, kind: "commit" }), { code: "project-mount-marker-invalid" });
    assertLiveComposeBytesUnchanged(current);
    assertStagedOverrideUnchanged(current);
  } finally {
    removeRealComposeCase(paths);
  }
});

// reject only the derived oversize override
test("rejects a generated bind that crosses the source-size boundary through real Compose", async (context) => {
  // stop when compose is unavailable
  if (!requireRealCompose(context)) return;
  const paths = createRealComposePaths();
  // always remove private inputs
  try {
    const currentApplication = application([]);
    const currentOverride = composeOverrideWithByteLength(MAX_SOURCE_BYTES - 32);
    const candidateProjects = [{ id: "literal", path: "/literal/target", hostPath: join(paths.root, "literal-source") }];
    const candidateApplication = application(candidateProjects);
    const current = initializeRealComposeCase(paths, currentApplication, currentOverride, literalDollarTarget);
    const request = stageRealComposeCase(current, candidateProjects);
    const validated = await validateComposeCandidates(current.descriptor, new Map([
      ["app", join(current.stage, "app")],
      ["compose-override", join(current.stage, "compose-override")]
    ]), current.stage, undefined, true);
    const derived = synchronizeProjectMounts(currentOverride, currentApplication, candidateApplication, validated.resolvedModel, current.root);
    assert.equal(Buffer.byteLength(currentOverride), MAX_SOURCE_BYTES - 32);
    assert.ok(Buffer.byteLength(derived) > MAX_SOURCE_BYTES);
    await assert.rejects(processOperation(current.descriptor, { ...request, kind: "commit" }), { code: "source-too-large" });
    assertLiveComposeBytesUnchanged(current);
    assertStagedOverrideUnchanged(current);
    assert.equal(readFileSync(join(current.stage, "app"), "utf8"), candidateApplication);
    assert.equal(existsSync(join(current.control, "journal", `${composeCaseId}.json`)), false);
    assert.equal(existsSync(join(current.control, "pending.json")), false);
  } finally {
    removeRealComposeCase(paths);
  }
});

// roll back after a late override race
test("rolls back app after a late override CAS conflict through real Compose", async (context) => {
  // stop when compose is unavailable
  if (!requireRealCompose(context)) return;
  const paths = createRealComposePaths();
  // always remove private inputs
  try {
    const currentApplication = application([]);
    const currentOverride = emptyComposeOverride;
    const candidateProjects = [{ id: "race", path: "/race/target", hostPath: join(paths.root, "race-source") }];
    const candidateApplication = application(candidateProjects);
    const current = initializeRealComposeCase(paths, currentApplication, currentOverride, literalDollarTarget);
    const request = stageRealComposeCase(current, candidateProjects);
    const observed = await validateAndObserveRealCompose(current, request);
    const concurrentOverride = `${emptyComposeOverride}      - /concurrent/source:/concurrent/target:ro\n`;
    mkdirSync(join(current.control, "recovery"), { mode: 0o700 });
    mkdirSync(join(current.control, "journal"), { mode: 0o700 });
    ensureRecoveryKey(current.control);
    await assert.rejects(processOperation(current.descriptor, { ...request, kind: "commit" }, {
      // accept the isolated baseline proof
      baselineProve: async (_descriptor, target) => {
        assert.equal(target, "rac");
        return {};
      },
      // replace override after its initial check
      beforeSourceWrite: (sourceId, path) => {
        // race only after the app check
        if (sourceId === "app") {
          assert.equal(path, current.app);
          writeFileSync(current.composeOverride, concurrentOverride);
        }
      }
    }), { code: "source-conflict" });
    assert.equal(readFileSync(current.app, "utf8"), currentApplication);
    assert.equal(readFileSync(current.composeOverride, "utf8"), concurrentOverride);
    assert.equal(readFileSync(join(current.stage, "app"), "utf8"), candidateApplication);
    assert.equal(readFileSync(join(current.stage, "compose-override"), "utf8"), observed.generated);
    const journal = JSON.parse(readFileSync(join(current.control, "journal", `${composeCaseId}.json`), "utf8"));
    assert.equal(journal.phase, "rolled-back");
    assert.deepEqual(journal.written, ["app"]);
    assert.equal(journal.receipt, undefined);
    assert.equal(existsSync(join(current.control, "pending.json")), false);
  } finally {
    removeRealComposeCase(paths);
  }
});
