#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <express-version>" >&2
  exit 2
fi

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
temporary_parent=$(CDPATH='' cd -- "${TMPDIR:-/tmp}" && pwd -P)
temporary_root=$(mktemp -d "$temporary_parent/cdn-proxy-cache-compatibility.XXXXXX")
case "$temporary_root" in
  "$temporary_parent"/cdn-proxy-cache-compatibility.*) ;;
  *)
    echo "unexpected temporary directory: $temporary_root" >&2
    exit 1
    ;;
esac
cleanup() {
  if [ ! -d "$temporary_root" ] || [ -L "$temporary_root" ]; then
    echo "refusing to remove unexpected temporary path: $temporary_root" >&2
    return 1
  fi
  rm -rf -- "$temporary_root"
}
trap cleanup EXIT HUP INT TERM
compatibility_node=${COMPAT_NODE:-$(command -v node)}
compatibility_npm_cli=$(dirname -- "$compatibility_node")/../lib/node_modules/npm/bin/npm-cli.js
if [ ! -x "$compatibility_node" ] || [ ! -f "$compatibility_npm_cli" ]; then
  echo "could not locate node and its npm CLI from $compatibility_node" >&2
  exit 1
fi

mkdir "$temporary_root/consumer"
package_archive=$(
  cd "$repo_root"
  "$compatibility_node" "$compatibility_npm_cli" pack \
    --silent --pack-destination "$temporary_root" --cache "$repo_root/.cache/npm"
)
case "$package_archive" in
  '' | */*)
    echo "unexpected package archive name: $package_archive" >&2
    exit 1
    ;;
esac
if [ ! -f "$temporary_root/$package_archive" ]; then
  echo "package archive was not created: $package_archive" >&2
  exit 1
fi
cd "$temporary_root/consumer"
"$compatibility_node" "$compatibility_npm_cli" init --yes --silent >/dev/null
"$compatibility_node" "$compatibility_npm_cli" install \
  --silent --cache "$repo_root/.cache/npm" "$temporary_root/$package_archive" \
  "express@$1" "typescript@5.9.3" "@types/node@18"
cp "$repo_root/scripts/compatibility-consumer.ts" .
"$compatibility_node" node_modules/typescript/bin/tsc \
  --strict --noEmit --module Node16 --moduleResolution Node16 --target ES2019 compatibility-consumer.ts
"$compatibility_node" "$repo_root/scripts/compatibility-smoke.cjs"
