#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${VNC_PASSWORD:-}" || "${VNC_PASSWORD}" == CHANGE_THIS_* || ${#VNC_PASSWORD} -lt 8 ]]; then
  echo "ERROR: Set VNC_PASSWORD to a unique value of at least 8 characters."
  exit 1
fi

export DISPLAY=:99

mkdir -p /data/profile /app/logs /tmp/vnc
chmod 700 /data/profile || true

echo "[1/5] Starting Xvfb..."
Xvfb :99 \
  -screen 0 1280x900x24 \
  -nolisten tcp \
  > /app/logs/xvfb.log 2>&1 &

# Wait until the X11 display socket is ready.
echo "[2/5] Waiting for Xvfb..."
for i in $(seq 1 100); do
  if [[ -S /tmp/.X11-unix/X99 ]]; then
    echo "Xvfb ready."
    break
  fi

  if [[ "$i" -eq 100 ]]; then
    echo "ERROR: Xvfb did not become ready."
    cat /app/logs/xvfb.log
    exit 1
  fi

  sleep 0.1
done

echo "[3/5] Starting Fluxbox..."
fluxbox \
  > /app/logs/fluxbox.log 2>&1 &

echo "[4/5] Starting x11vnc..."
x11vnc -storepasswd "${VNC_PASSWORD}" /tmp/vnc/passwd >/dev/null

x11vnc \
  -display :99 \
  -forever \
  -shared \
  -rfbport 5900 \
  -rfbauth /tmp/vnc/passwd \
  -noxdamage \
  > /app/logs/x11vnc.log 2>&1 &

# Wait until x11vnc is accepting local connections.
for i in $(seq 1 100); do
  if bash -c '</dev/tcp/127.0.0.1/5900' >/dev/null 2>&1; then
    echo "x11vnc ready."
    break
  fi

  if [[ "$i" -eq 100 ]]; then
    echo "ERROR: x11vnc did not become ready."
    cat /app/logs/x11vnc.log
    exit 1
  fi

  sleep 0.1
done

echo "[5/5] Starting noVNC..."
websockify \
  --web=/usr/share/novnc \
  6080 \
  localhost:5900 \
  > /app/logs/novnc.log 2>&1 &

exec node /app/src/login.mjs
