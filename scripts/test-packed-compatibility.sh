#!/bin/sh
set -eu

exec "${COMPAT_NODE:-node}" "$(dirname -- "$0")/test-packed-compatibility.cjs" "$@"
