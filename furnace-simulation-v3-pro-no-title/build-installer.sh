#!/bin/sh
# Creates a GitHub-release-ready, self-extracting Ubuntu installer.
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPOSITORY_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
APP_DIR_NAME="$(basename "$SCRIPT_DIR")"
OUTPUT="$SCRIPT_DIR/Furnace-Simulation-Installer.run"
STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/furnace-simulation-package.XXXXXX")"

cleanup() {
    rm -rf "$STAGING_DIR"
}
trap cleanup EXIT HUP INT TERM

if ! command -v git >/dev/null 2>&1 || ! git -C "$REPOSITORY_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf '%s\n' "Build error: run this script from a checked-out Git repository." >&2
    exit 1
fi

# Git's tracked file list excludes .env and .secrets, preventing local credentials
# from entering the downloadable installer.
{
    git -C "$REPOSITORY_DIR" ls-files -z -- "$APP_DIR_NAME"
    printf '%s\0' "$APP_DIR_NAME/Furnice-simulator-icon.png"
} |
    tar -C "$REPOSITORY_DIR" --null --files-from=- -czf "$STAGING_DIR/payload.tar.gz"

cat "$SCRIPT_DIR/install-furnace-simulation.sh" "$STAGING_DIR/payload.tar.gz" > "$OUTPUT"
chmod 755 "$OUTPUT"
printf 'Created %s\n' "$OUTPUT"
