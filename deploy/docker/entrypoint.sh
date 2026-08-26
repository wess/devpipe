#!/bin/sh
set -eu

# A Docker named volume keeps the ownership set in the image. A Runpod network
# volume is mounted after the image is unpacked and may arrive owned by root, so
# fix only the workspace mount before dropping privileges for the daemon and
# every PTY it creates.
mkdir -p /home/devpipe/work
chown devpipe:devpipe /home/devpipe/work

exec runuser -u devpipe -- /usr/local/bin/devpiped
