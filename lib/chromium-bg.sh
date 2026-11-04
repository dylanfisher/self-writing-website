#!/bin/sh
# Starts the page-check Chromium as a background task (macOS: efficiency cores, lowest CPU and I/O priority),
# so model-written pages can't take CPU from builds or the model. Child processes inherit the policy.
exec /usr/sbin/taskpolicy -b "$CHECK_CHROMIUM" "$@"
