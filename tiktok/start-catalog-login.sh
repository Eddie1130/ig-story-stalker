#!/bin/sh
set -eu
if [ "${#VNC_PASSWORD}" -lt 8 ]; then
  echo 'VNC_PASSWORD must contain at least 8 characters.' >&2
  exit 1
fi
umask 077
export DISPLAY=:99
Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 &
xvfb_pid=$!
cleanup() { kill "$xvfb_pid" "${vnc_pid:-}" "${web_pid:-}" "${wm_pid:-}" 2>/dev/null || true; }
trap cleanup EXIT
sleep 1
fluxbox >/dev/null 2>&1 &
wm_pid=$!
x11vnc -storepasswd "$VNC_PASSWORD" /tmp/vnc.pass >/dev/null 2>&1
x11vnc -display :99 -rfbauth /tmp/vnc.pass -rfbport 5900 -localhost -forever -shared >/dev/null 2>&1 &
vnc_pid=$!
websockify --web=/usr/share/novnc/ 6081 localhost:5900 >/dev/null 2>&1 &
web_pid=$!
python /app/catalog_login.py &
login_pid=$!
trap 'kill -TERM "$login_pid" 2>/dev/null || true; wait "$login_pid" || true; cleanup' INT TERM
wait "$login_pid"
