#!/usr/bin/python3
"""Signal exact interactive Agent CLI lifetimes through Linux pidfds."""

import base64
import json
import os
import re
import signal
import sys
import time


CODEX_HELPERS = {
    "app-server", "auth", "cloud", "completion", "debug", "exec", "features",
    "login", "logout", "mcp", "mcp-server", "review", "sandbox"
}
NODE_VALUE_FLAGS = {"-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions"}
NODE_SWITCHES = {"--no-warnings", "--enable-source-maps", "--preserve-symlinks", "--preserve-symlinks-main"}
OMX_WORKER = re.compile(r"(?:^|/)\.omx/(?:team/[^/]+/worktrees/worker-\d+(?:/|$)|state/team/[^/]+/runtime/worker-\d+-startup\.sh(?:[\s'\"/]|$))")
KINDS = {"codex", "omx", "claude", "pi"}


# extract one executable basename
def base(value):
    return os.path.basename(value or "")


# resolve only the actual executable or node script, mirroring the server
def entry_index(argv):
    if not argv or not re.fullmatch(r"node(?:js)?(?:\.exe)?", base(argv[0]), re.IGNORECASE):
        return 0
    index = 1
    # consume only supported node options before reaching the script
    while index < len(argv):
        argument = argv[index]
        # a positional or literal script boundary ends flag parsing
        if argument == "--":
            return index + 1
        if not argument.startswith("-"):
            return index
        # skip supported runtime switches and their fixed arity values
        if argument in NODE_SWITCHES or argument.startswith("--") and "=" in argument and argument.split("=", 1)[0] in NODE_VALUE_FLAGS:
            index += 1
            continue
        if argument in NODE_VALUE_FLAGS:
            index += 2
            continue
        # unknown options and non-script modes cannot prove a launcher
        return -1
    return -1


# find Codex's first positional command after global options
def codex_command(arguments):
    valued = {"-c", "--config", "-m", "--model", "-s", "--sandbox", "-a", "--ask-for-approval", "--approval-policy", "-C", "--cd", "--add-dir", "-i", "--image", "-p", "--profile"}
    index = 0
    # inspect only the option prefix
    while index < len(arguments):
        argument = arguments[index]
        # a literal boundary makes the next value positional
        if argument == "--":
            return arguments[index + 1] if index + 1 < len(arguments) else None
        # skip fixed options and their separate values
        if argument in valued:
            index += 2
            continue
        # attached options carry no separate value
        if argument.startswith("-"):
            index += 1
            continue
        return argument
    return None


# identify only one interactive registered cli process
def recognized_kind(_comm, argv):
    index = entry_index(argv)
    # never use a later application argument or mutable comm as the entry
    if index < 0 or index >= len(argv):
        return None
    entry = argv[index]
    program = base(entry)
    arguments = argv[index + 1:]
    # reject Codex helper subcommands
    if re.fullmatch(r"codex(?:\.js)?", program, re.IGNORECASE):
        return "codex" if codex_command(arguments) not in CODEX_HELPERS else None
    # mirror OMX's leader dispatcher
    if re.fullmatch(r"omx(?:\.js)?", program, re.IGNORECASE):
        first = arguments[0] if arguments else None
        return "omx" if first is None or first in {"launch", "resume"} or first.startswith("--") and first not in {"--help", "--version"} else None
    # exclude print and stream protocol workers
    if program != "claude" and (index == 0 or not re.search(r"(?:^|/)@anthropic-ai/claude-code/cli\.js$", entry)):
        return None
    return None if any(argument == "-p" or argument.startswith("-p=") or argument == "--print" or argument.startswith("--print=") or argument == "--input-format" or argument.startswith("--input-format=") or argument == "--output-format" or argument.startswith("--output-format=") for argument in arguments) else "claude"


# read one bounded proc text file
def read_text(path, limit=65536):
    with open(path, "rb") as stream:
        data = stream.read(limit + 1)
    # reject unbounded process metadata
    if len(data) > limit:
        raise ValueError("oversized proc record")
    return data.decode("utf-8", "surrogateescape")


# parse stat without trusting spaces or parentheses in comm
def read_stat(proc_root, pid):
    raw = read_text(os.path.join(proc_root, str(pid), "stat"))
    close = raw.rfind(")")
    # require a canonical stat prefix and all lifetime fields
    if close < 0 or not raw[:raw.find("(")].strip().isdigit():
        raise ValueError("invalid stat")
    fields = raw[close + 2:].strip().split()
    # retain state, parent and start time only
    if len(fields) <= 19 or not fields[1].isdigit() or not fields[19].isdigit():
        raise ValueError("invalid stat")
    return fields[0], int(fields[1]), fields[19]


# recognize one Pi child only through RAC's exact holder launch proof
def rac_pi_process(proc_root, comm, argv, parent_pid, expected_uid):
    # Pi deliberately overwrites its own argv after startup
    if comm != "pi" or argv != ["pi"] or parent_pid <= 1:
        return False
    try:
        root = os.path.join(proc_root, str(parent_pid))
        parent = [part for part in read_text(os.path.join(root, "cmdline")).split("\0") if part]
        status = read_text(os.path.join(root, "status"))
        boundary = parent.index("--")
        holder = parent[1] if len(parent) > 1 else ""
        launched = parent[boundary + 1:]
        match = re.match(r"^(.*)/apps/server/(?:src|dist)/transports/holder\.(?:ts|js)$", holder)
        uids = re.search(r"^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$", status, re.MULTILINE)
        # require one same-user repository holder and the pinned cli entry
        if boundary < 3 or match is None or uids is None or any(int(value) != expected_uid for value in uids.groups()[:3]) or len(launched) < 2 or not launched[1].endswith("/@earendil-works/pi-coding-agent/dist/bundle/cli.js"):
            return False
        mode = launched.index("--mode")
        extension = launched.index("-e")
        repository = re.escape(match.group(1))
        # bind RPC mode to RAC's extension in the same repository
        return launched[mode + 1] == "rpc" and "-ne" in launched and "--offline" in launched and "--no-approve" in launched and re.fullmatch(repository + r"/apps/server/(?:src|dist)/adapters/pi-extension\.(?:ts|js)", launched[extension + 1]) is not None
    except (FileNotFoundError, PermissionError, ValueError, IndexError, OSError):
        return False


# read one process command and recognition kind
def process_kind(proc_root, pid, expected_uid=None):
    root = os.path.join(proc_root, str(pid))
    comm = read_text(os.path.join(root, "comm"), 4096).strip()
    cmdline = read_text(os.path.join(root, "cmdline"))
    argv = cmdline.rstrip("\0").split("\0")
    kind = recognized_kind(comm, argv)
    # Pi requires its parent holder and expected user as additional proof
    if kind is None and expected_uid is not None:
        _, parent_pid, _ = read_stat(proc_root, pid)
        if rac_pi_process(proc_root, comm, argv, parent_pid, expected_uid):
            kind = "pi"
    return kind, cmdline


# prove no interactive Agent owns this process as a descendant
def has_agent_ancestor(proc_root, parent_pid):
    seen = set()
    current = parent_pid
    # bound parent traversal and reject cycles
    while current > 1 and current not in seen and len(seen) < 64:
        seen.add(current)
        try:
            kind, _ = process_kind(proc_root, current)
            # any interactive Agent ancestor owns this child process
            if kind is not None:
                return True
            _, current, _ = read_stat(proc_root, current)
        except (FileNotFoundError, ProcessLookupError, PermissionError, ValueError, OSError):
            return False
    return False


# validate and signal one pidfd-bound identity
def terminate(target, deadline, proc_root="/proc"):
    pid = target["pid"]
    start_time = target["startTime"]
    expected_uid = target["uid"]
    expected_kind = target["kind"]
    result = {"pid": pid, "startTime": start_time, "status": "failed"}
    # refuse unsupported runtimes instead of falling back to racy pid signaling
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        return result
    try:
        pidfd = os.pidfd_open(pid, 0)
    except ProcessLookupError:
        result["status"] = "not_found"
        return result
    except OSError:
        return result
    try:
        # a queued request cannot acquire signaling authority after expiry
        if int(time.time() * 1000) >= deadline:
            result["status"] = "stale"
            return result
        try:
            state, parent_pid, observed_start = read_stat(proc_root, pid)
            status = read_text(os.path.join(proc_root, str(pid), "status"), 65536)
            match = re.search(r"^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$", status, re.MULTILINE)
            # require one live unchanged lifetime and credentials
            if state in {"Z", "X"} or observed_start != start_time:
                result["status"] = "stale"
                return result
            if match is None or any(int(value) != expected_uid for value in match.groups()[:3]):
                result["status"] = "rejected"
                return result
            kind, cmdline = process_kind(proc_root, pid, expected_uid)
            cwd = os.readlink(os.path.join(proc_root, str(pid), "cwd"))
            # independently recheck recognition, interactive mode and worker exclusions
            if kind != expected_kind or OMX_WORKER.search(cwd) or OMX_WORKER.search(cmdline.replace("\0", " ")) or has_agent_ancestor(proc_root, parent_pid):
                result["status"] = "rejected"
                return result
        except FileNotFoundError:
            result["status"] = "not_found"
            return result
        except (PermissionError, ValueError, OSError):
            result["status"] = "rejected"
            return result
        # validation time cannot extend an expired signaling grant
        if int(time.time() * 1000) >= deadline:
            result["status"] = "stale"
            return result
        try:
            signal.pidfd_send_signal(pidfd, signal.SIGTERM, None, 0)
            result["status"] = "signal_sent"
        except ProcessLookupError:
            result["status"] = "stale"
        except OSError:
            result["status"] = "failed"
        return result
    finally:
        os.close(pidfd)


# decode one strict queue payload
def request_payload(encoded):
    padding = "=" * (-len(encoded) % 4)
    value = json.loads(base64.urlsafe_b64decode(encoded + padding))
    # accept only the fixed deadline and targets envelope
    if not isinstance(value, dict) or set(value) != {"deadline", "targets"} or not isinstance(value["deadline"], int) or not isinstance(value["targets"], list) or not 1 <= len(value["targets"]) <= 20:
        raise ValueError("invalid request")
    # validate every exact target tuple
    for target in value["targets"]:
        if not isinstance(target, dict) or set(target) != {"pid", "startTime", "uid", "kind"} or not isinstance(target["pid"], int) or target["pid"] <= 1 or not isinstance(target["uid"], int) or target["uid"] < 0 or not isinstance(target["startTime"], str) or not target["startTime"].isdigit() or target["kind"] not in KINDS:
            raise ValueError("invalid target")
    return value


# run one bounded host request
def main(argv):
    # require exactly one encoded fixed payload
    if len(argv) != 1 or len(argv[0]) > 16384:
        return 2
    try:
        request = request_payload(argv[0])
        results = [terminate(target, request["deadline"]) for target in request["targets"]]
    except (ValueError, TypeError, KeyError, json.JSONDecodeError, base64.binascii.Error):
        return 2
    sys.stdout.write(json.dumps({"version": 1, "results": results}, separators=(",", ":")) + "\n")
    return 0


# keep imports side-effect free for isolated validation tests
if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
