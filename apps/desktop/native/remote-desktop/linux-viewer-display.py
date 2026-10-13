#!/usr/bin/python3
"""One lease's temporary Hyprland mirror; restore on EOF, timeout or termination.

No config files, shell evaluation, screenshots, credentials or persisted geometry.
The child outlives a crashing Electron parent long enough to undo its own changes.
"""
import json
import os
import re
import select
import signal
import stat
import subprocess
import sys
import time
import uuid


def trusted(path):
    info = os.stat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or not info.st_mode & 0o111:
        raise RuntimeError("system executable unavailable")


def owned_session(allow_locked=False):
    session = os.environ.get("XDG_SESSION_ID", "")
    if (os.getuid() <= 0 or os.getuid() != os.geteuid() or
            not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", session) or
            not os.environ.get("HYPRLAND_INSTANCE_SIGNATURE") or
            not (os.environ.get("XDG_SESSION_TYPE") == "wayland" or os.environ.get("WAYLAND_DISPLAY"))):
        raise RuntimeError("session unavailable")
    trusted("/usr/bin/hyprctl")
    trusted("/usr/bin/loginctl")
    result = subprocess.run(["/usr/bin/loginctl", "show-session", session, "-p", "User", "-p", "Active",
                             "-p", "Remote", "-p", "Type", "-p", "LockedHint"],
                            capture_output=True, timeout=2, check=True, text=True)
    if len(result.stdout) > 4096:
        raise RuntimeError("session unavailable")
    values = {}
    for line in result.stdout.strip().split("\n"):
        key, separator, value = line.partition("=")
        if not separator or key in values:
            raise RuntimeError("session unavailable")
        values[key] = value
    if (len(values) != 5 or values.get("User") != str(os.getuid()) or values.get("Active") != "yes" or
            values.get("Remote") != "no" or values.get("Type") != "wayland" or
            values.get("LockedHint") not in ("yes", "no")):
        raise RuntimeError("session unavailable")
    monitors = subprocess.run(["/usr/bin/hyprctl", "-j", "monitors"], capture_output=True,
                              timeout=2, check=True, text=True)
    if len(monitors.stdout) > 128000:
        raise RuntimeError("session unavailable")
    layout = json.loads(monitors.stdout)
    if not isinstance(layout, list) or not 1 <= len(layout) <= 32:
        raise RuntimeError("session unavailable")
    blockers = [monitor.get("solitaryBlockedBy") for monitor in layout if isinstance(monitor, dict)]
    if len(blockers) != len(layout) or any(not isinstance(items, list) or len(items) > 32 or
            any(not isinstance(item, str) or len(item) > 128 for item in items) for items in blockers):
        raise RuntimeError("session unavailable")
    if any("LOCK" in items for items in blockers):
        if allow_locked:
            return
        raise RuntimeError("session locked")
    if not any("WORKSPACE" not in items for items in blockers):
        raise RuntimeError("session unavailable")


def command(*args, allow_locked=False):
    owned_session(allow_locked)
    result = subprocess.run(["/usr/bin/hyprctl", *args], capture_output=True,
                            timeout=3, check=True, text=True)
    if len(result.stdout) > 128000:
        raise RuntimeError("response too large")
    owned_session(allow_locked)
    return result.stdout


class ViewerDisplay:
    """Own only the generated output and the source's temporary mirror rule."""
    def __init__(self, source, run=None, name=None):
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", source):
            raise ValueError("invalid source")
        self.restoring = False
        self.run = run or (lambda *args: command(*args, allow_locked=self.restoring))
        self.source = source
        self.name = name or "JokoRemote-" + uuid.uuid4().hex[:16]
        if not re.fullmatch(r"JokoRemote-[a-f0-9]{16}", self.name) or self.name == source:
            raise ValueError("invalid owned output")
        self.original = None
        self.created = False
        self.mirrored = False
        try:
            self.lua = self.run("eval", 'assert(type(hl.monitor) == "function")').strip() == "ok"
        except Exception:
            self.lua = False

    def monitors(self):
        monitors = json.loads(self.run("-j", "monitors", "all"))
        if not isinstance(monitors, list) or len(monitors) > 32:
            raise RuntimeError("invalid monitors")
        names = set()
        for monitor in monitors:
            if (not isinstance(monitor, dict) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", monitor.get("name", "")) or
                    monitor["name"] in names or any(type(monitor.get(k)) is not int for k in ("width", "height", "x", "y", "transform")) or
                    not 1 <= monitor["width"] <= 16384 or not 1 <= monitor["height"] <= 16384 or
                    abs(monitor["x"]) > 1000000 or abs(monitor["y"]) > 1000000 or not 0 <= monitor["transform"] <= 7 or
                    type(monitor.get("scale")) not in (int, float) or not 0.25 <= monitor["scale"] <= 8 or
                    type(monitor.get("refreshRate")) not in (int, float) or not 0 < monitor["refreshRate"] <= 1000):
                raise RuntimeError("invalid monitor")
            names.add(monitor["name"])
        return monitors

    def rule(self, monitor, mirror=None):
        value = (f"{monitor['name']},{monitor['width']}x{monitor['height']}@{monitor['refreshRate']},"
                 f"{monitor['x']}x{monitor['y']},{monitor['scale']},transform,{monitor['transform']}")
        if mirror:
            value += f",mirror,{mirror}"
        if "vrr" in monitor:
            value += ",vrr," + ("1" if monitor["vrr"] else "0")
        if self.lua:
            # Every string here is an enumerated/validated output or a generated
            # numeric mode. No remote code or arbitrary Lua is accepted.
            fields = {"output": monitor["name"], "mode": f"{monitor['width']}x{monitor['height']}@{monitor['refreshRate']}",
                      "position": f"{monitor['x']}x{monitor['y']}", "scale": monitor["scale"],
                      "transform": monitor["transform"], "mirror": mirror or ""}
            # hl.monitor merges an existing named rule. Omit unrelated color,
            # HDR and VRR fields so a temporary mirror never replaces them.
            code = "hl.monitor({" + ",".join(k + "=" + json.dumps(v) for k, v in fields.items()) + "})"
            result = self.run("eval", code)
        else:
            result = self.run("keyword", "monitor", value)
        if result.strip() != "ok":
            raise RuntimeError("monitor rejected")

    def move_workspaces(self, source, target):
        workspaces = json.loads(self.run("-j", "workspaces"))
        if not isinstance(workspaces, list) or len(workspaces) > 128 or any(not isinstance(w, dict) for w in workspaces):
            raise RuntimeError("too many workspaces")
        for workspace in workspaces:
            ident = workspace.get("id")
            name = workspace.get("name", "")
            if workspace.get("monitor") == source and type(ident) is int and ident != 0:
                if not isinstance(name, str) or name.startswith("special:"):
                    continue
                selector = ident if ident > 0 else "name:" + name
                if ident < 0 and (not name or any(ord(c) < 32 for c in name) or
                                  (any(c.isspace() for c in name) and not self.lua)):
                    raise RuntimeError("workspace name unavailable")
                if self.lua:
                    result = self.run("eval", f"hl.dispatch(hl.dsp.workspace.move({{workspace={json.dumps(selector, ensure_ascii=False)},monitor={json.dumps(target)}}}))")
                else:
                    result = self.run("dispatch", "moveworkspacetomonitor", f"{selector} {target}")
                if result.strip() != "ok":
                    raise RuntimeError("workspace rejected")

    def resize(self, width, height):
        if (type(width) is not int or type(height) is not int or
                not 320 <= width <= 2560 or not 320 <= height <= 2560):
            raise ValueError("invalid dimensions")
        if self.original is None:
            self.original = next(m for m in self.monitors() if m["name"] == self.source)
            if self.original.get("mirrorOf", "none") != "none" or self.original.get("specialWorkspace", {}).get("id", 0):
                raise RuntimeError("source unavailable")
        if not self.created:
            # Record intent before invoking the compositor: an interrupted reply
            # must still remove this unique output during cleanup.
            self.created = True
            if self.run("output", "create", "headless", self.name).strip() != "ok":
                raise RuntimeError("output rejected")
        monitors = self.monitors()
        right = max(m["x"] + round((m["height"] if m["transform"] % 2 else m["width"]) / m["scale"])
                    for m in monitors if m["name"] != self.name)
        self.rule({"name": self.name, "width": width, "height": height, "refreshRate": 60,
                   "x": right, "y": 0, "scale": 1, "transform": 0})
        if not self.mirrored:
            self.move_workspaces(self.source, self.name)
            self.mirrored = True
            self.rule(self.original, self.name)
        for _ in range(40):
            monitor = next((m for m in self.monitors() if m["name"] == self.name), None)
            if monitor and monitor["width"] == width and monitor["height"] == height:
                return {"id": "hyprland:" + self.name, "name": self.name, "width": width, "height": height}
            time.sleep(0.05)
        raise RuntimeError("output did not settle")

    def restore(self):
        self.restoring = True
        if not self.created:
            return
        monitors = self.monitors()
        if any(m["name"] == self.source for m in monitors):
            if self.mirrored:
                self.rule(self.original)
            self.move_workspaces(self.name, self.source)
        if any(m["name"] == self.name for m in monitors):
            if self.run("output", "remove", self.name).strip() != "ok":
                raise RuntimeError("output removal rejected")
        for _ in range(40):
            layout = self.monitors()
            source = next((m for m in layout if m["name"] == self.source), None)
            if not any(m["name"] == self.name for m in layout) and (source is None or
                    (source.get("mirrorOf", "none") == "none" and all(source[k] == self.original[k]
                     for k in ("width", "height", "x", "y", "scale", "transform")))):
                break
            time.sleep(0.05)
        else:
            raise RuntimeError("restoration did not settle")
        self.created = False
        self.mirrored = False


def main():
    if len(sys.argv) != 3:
        return 2
    owner = ViewerDisplay(sys.argv[1], name=sys.argv[2])
    def terminate(_signum, _frame):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    buffer = b""
    try:
        while select.select([sys.stdin], [], [], 6)[0]:
            chunk = os.read(sys.stdin.fileno(), 1024)
            if not chunk:
                break
            buffer += chunk
            if len(buffer) > 8192:
                raise ValueError("input too large")
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                value = json.loads(line)
                if value.get("op") == "ping":
                    continue
                result = owner.resize(value.get("width"), value.get("height"))
                print(json.dumps(result), flush=True)
    except Exception:
        # Diagnostics may contain compositor state. Return a fixed error only.
        try:
            print('{"error":"REMOTE_DESKTOP_VIEWER_DISPLAY_UNAVAILABLE"}', flush=True)
        except BrokenPipeError:
            pass
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        # Keep the in-memory snapshot alive through temporary compositor errors.
        # A vanished compositor socket means its temporary outputs vanished too.
        socket = os.path.join(os.environ.get("XDG_RUNTIME_DIR", ""), "hypr",
                              os.environ.get("HYPRLAND_INSTANCE_SIGNATURE", ""), ".socket.sock")
        attempt = 0
        while True:
            try:
                owner.restore()
                return 0
            except Exception:
                if not os.path.exists(socket):
                    return 0
                attempt += 1
                time.sleep(min(5, 0.2 * attempt))


if __name__ == "__main__":
    sys.exit(main())
