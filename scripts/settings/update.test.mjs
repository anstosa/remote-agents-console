import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// preserve safe checkout modes even when the launching account shares group writes
test("updater normalizes checkout creation permissions before merging", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rac-update-modes-"));
  const bin = resolve(root, "bin");
  const control = resolve(root, "control");
  const operation = "update-modes-regression-0001";
  const target = "a".repeat(40);
  const script = fileURLToPath(new URL("../update-server.sh", import.meta.url));
  try {
    mkdirSync(bin);
    mkdirSync(control);
    // stub only the external git and helper boundaries
    writeFileSync(resolve(bin, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(resolve(bin, "git"), `#!/bin/sh
case "$1" in
  symbolic-ref) printf 'main\\n' ;;
  rev-parse) printf '%s\\n' "$TEST_TARGET" ;;
  diff|fetch|merge-base) exit 0 ;;
  merge) touch compose.yaml ;;
  *) exit 95 ;;
esac
`, { mode: 0o755 });
    const result = spawnSync("/bin/bash", ["-c", 'umask 002; exec /bin/bash "$1" "$2" "$3"', "update-test", script, operation, target], {
      cwd: root,
      env: { ...process.env, BASH_ENV: "/dev/null", PATH: `${bin}:${process.env.PATH}`, RAC_SETTINGS_CONTROL_ROOT: control, TEST_TARGET: target },
      encoding: "utf8",
      timeout: 120_000
    });
    assert.equal(result.status, 0, result.stderr || readFileSync(resolve(root, `.data/server-update-${operation}.log`), "utf8"));
    assert.equal(JSON.parse(readFileSync(resolve(root, ".data/server-update-last.json"), "utf8")).state, "complete");
    assert.equal(statSync(resolve(root, "compose.yaml")).mode & 0o777, 0o644);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
