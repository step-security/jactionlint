#!/bin/sh
# Run Node.js or npm with an existing compatible Node.js, or scope the mise
# fallback to this command. Keep Node out of the project's general PATH.
set -u

minimum_major=22
minimum_minor=12
tool=${1:-}
shift || true
case "$tool" in
  node|npm) ;;
  *) printf 'usage: run-node.sh <node|npm> <arguments...>\n' >&2; exit 2 ;;
esac

node_path=$(command -v node 2>/dev/null || true)
tool_path=$(command -v "$tool" 2>/dev/null || true)
if [ -n "$node_path" ]; then
  node_version=$(node --version 2>/dev/null || true)
  if printf '%s\n' "$node_version" | grep -Eq '^v?[0-9]+\.'; then
    node_major=$(printf '%s\n' "$node_version" | sed -E 's/^v?([0-9]+)\..*/\1/')
    node_minor=$(printf '%s\n' "$node_version" | sed -E 's/^v?[0-9]+\.([0-9]+)\..*/\1/')
    if [ "$node_major" -gt "$minimum_major" ] || { [ "$node_major" -eq "$minimum_major" ] && [ "$node_minor" -ge "$minimum_minor" ]; }; then
      if [ -n "$tool_path" ] && { [ "$tool" != npm ] || ! printf '%s' "$tool_path" | grep -Eqi '[/\\]\.socket[/\\]'; }; then exec "$tool_path" "$@"; fi
      printf 'upstream: %s is compatible, but %s is unavailable; using a task-scoped mise LTS runtime\n' "$node_path" "$tool" >&2
    else
      printf 'upstream: %s is %s; requires Node.js >= %s.%s, using a task-scoped mise LTS runtime\n' "$node_path" "$node_version" "$minimum_major" "$minimum_minor" >&2
    fi
  else
    printf 'upstream: %s did not report a Node.js version; using a task-scoped mise LTS runtime\n' "$node_path" >&2
  fi
else
  printf 'upstream: Node.js is not on PATH; using a task-scoped mise LTS runtime\n' >&2
fi

mise_path=$(command -v mise 2>/dev/null || true)
if [ -z "$mise_path" ]; then
  printf 'upstream: install Node.js >= %s.%s or add mise to PATH for a scoped LTS fallback\n' "$minimum_major" "$minimum_minor" >&2
  exit 127
fi
if [ "$tool" = npm ] && [ -n "$tool_path" ] && printf '%s' "$tool_path" | grep -Eqi '[/\\]\.socket[/\\]'; then
  exec mise exec node@lts -- "$tool_path" "$@"
fi
exec mise exec node@lts -- "$tool" "$@"
