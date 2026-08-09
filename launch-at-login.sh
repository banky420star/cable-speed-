#!/bin/bash
# Launches Cable Speed Monitor at login, waiting for the external volume to
# mount first (the app lives on /Volumes/AI_DRIVE, which mounts after login
# agents run). Retries for up to ~2 minutes, then gives up quietly.
APP="/Volumes/AI_DRIVE/cable app/Cable Speed Monitor.app"
for i in $(seq 1 60); do
  if [ -d "$APP" ]; then
    open "$APP"
    exit 0
  fi
  sleep 2
done
exit 1
