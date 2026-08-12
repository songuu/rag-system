#!/usr/bin/env sh
# Next's Windows standalone output can retain absolute pnpm junction targets.
# Repoint only those known workspace targets after copying the artifact into a
# Linux image. A real Linux build remains the preferred release path.
set -eu

root="${1:-/app}"
prefix='C:\project\my\rag-system\node_modules\'
rewritten=0

find "$root" -type l -exec sh -c '
  prefix="$1"
  root="$2"
  shift 2
  for link in "$@"; do
    target=$(readlink "$link")
    case "$target" in
      "$prefix"*)
        suffix=${target#"$prefix"}
        suffix=$(printf "%s" "$suffix" | sed "s#\\\\#/#g")
        rm "$link"
        ln -s "$root/node_modules/$suffix" "$link"
        printf "%s\n" "$link"
        ;;
    esac
  done
' sh "$prefix" "$root" {} + | while IFS= read -r _rewritten; do
  rewritten=$((rewritten + 1))
done

# The loop runs in a subshell on POSIX sh, so count from the final tree rather
# than relying on its local variable. This remains safe because only the known
# workspace prefix is rewritten above.
remaining=$(find "$root" -type l -exec sh -c 'readlink "$1"' sh {} \; | grep -Ec '^[A-Za-z]:\\' || true)
if [ "$remaining" -ne 0 ]; then
  echo "Unresolved Windows absolute symlinks remain: $remaining" >&2
  exit 1
fi

echo "Windows standalone symlink normalization completed."
