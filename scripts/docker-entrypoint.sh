#!/bin/sh
# Container entrypoint. Starts as root only to make the data folder writable, then runs the app as PUID:PGID
# (default 65534, nobody). Docker creates a missing bind-mount folder as root, and restored or copied data can
# belong to any uid, so without this the app can't open its database on a fresh host.
# Started with `--user` (or `user:` in Compose) it can't change ownership and just runs the app as that user.
set -eu

data_dir="${DATA_DIR:-/data}"
uid="${PUID:-65534}"
gid="${PGID:-65534}"

if [ "$(id -u)" = 0 ]; then
  mkdir -p "$data_dir"
  # Only touch what isn't already owned by the app user, so restarts with a large uploads folder stay fast.
  find "$data_dir" \( ! -user "$uid" -o ! -group "$gid" \) -exec chown "$uid:$gid" {} +
  exec setpriv --reuid="$uid" --regid="$gid" --clear-groups -- "$@"
fi

exec "$@"
