#!/usr/bin/env bash
set -euo pipefail

# xvfb-run owns the private display; this wrapper owns only its window manager.
if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_OS:-}" != Linux || "$(uname -s)" != Linux
  || ! "${DISPLAY:-}" =~ ^:[0-9]+(\.[0-9]+)?$ || -z "${RUNNER_TEMP:-}" || $# -eq 0 ]]; then
  echo 'Linux GUI execution requires an Actions-owned Xvfb display and a command.' >&2
  exit 2
fi
if ! command -v openbox >/dev/null || ! command -v xprop >/dev/null; then
  echo 'Linux GUI execution requires the installed Openbox and X11 utilities.' >&2
  exit 2
fi
if [[ "$(xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null)" =~ window\ id\ \#\ 0x[1-9a-fA-F][0-9a-fA-F]* ]]; then
  echo 'Linux GUI execution refuses to replace an existing window manager.' >&2
  exit 2
fi

umask 077
mkdir -p "$RUNNER_TEMP/joko-ci-logs"
wm_log="$(mktemp "$RUNNER_TEMP/joko-ci-logs/linux-window-manager-XXXXXX.log")"
wm_pid=''
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$wm_pid" ]]; then
    if kill -0 "$wm_pid" 2>/dev/null; then
      kill -TERM "$wm_pid" 2>/dev/null || true
      for ((attempt = 0; attempt < 20; attempt += 1)); do
        if ! kill -0 "$wm_pid" 2>/dev/null; then break; fi
        sleep 0.1
      done
      if kill -0 "$wm_pid" 2>/dev/null; then kill -KILL "$wm_pid" 2>/dev/null || true; fi
    fi
    wait "$wm_pid" 2>/dev/null || true
    echo 'JOKO_LINUX_GUI_WINDOW_MANAGER_RETIRED'
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Run the WM directly: no desktop session, autostart applications, or replacement
# of another display's manager. Native minimize/restore requests remain real.
openbox --sm-disable >"$wm_log" 2>&1 &
wm_pid=$!
ready=false
for ((attempt = 0; attempt < 100; attempt += 1)); do
  if ! kill -0 "$wm_pid" 2>/dev/null; then
    echo 'Linux GUI window manager exited before becoming ready.' >&2
    exit 1
  fi
  if [[ "$(xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null)" =~ window\ id\ \#\ 0x[1-9a-fA-F][0-9a-fA-F]* ]]; then
    ready=true
    break
  fi
  sleep 0.1
done
if [[ "$ready" != true ]]; then
  echo 'Linux GUI window manager did not publish its X11 readiness property.' >&2
  exit 1
fi
echo 'JOKO_LINUX_GUI_WINDOW_MANAGER_READY'
status=0
"$@" || status=$?
if ! kill -0 "$wm_pid" 2>/dev/null && [[ "$status" -eq 0 ]]; then
  echo 'Linux GUI window manager exited during the command.' >&2
  status=1
fi
exit "$status"
