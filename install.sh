#!/bin/sh
# Replay installer — no Node.js required.
#
# Replay's runtime bundles its own Node binary, so this script installs it
# without Node on your machine. It downloads the pinned macOS Apple Silicon
# runtime from GitHub Releases, verifies it against the published sha256, lays
# it under ~/.replay/runtimes/<version>, points a stable `current` symlink at
# it, and prints the MCP server config your coding agent needs.
#
#   curl -fsSL <this script's raw URL> | sh        # one-liner
#   sh install.sh                                  # from a checkout
#
# Environment overrides:
#   REPLAY_VERSION     version to install (default 0.2.3)
#   REPLAY_GITHUB      owner/repo hosting releases (default that-one-arab/replay)
#   REPLAY_RELEASE_BASE  override the entire download base (default: the GitHub release URL)
#   REPLAY_HOME        install root (default ~/.replay)
#
# Requires curl, tar, and shasum (or sha256sum). macOS Apple Silicon only.
# The GitHub repo must be public for anonymous downloads.

set -eu

GITHUB="${REPLAY_GITHUB:-that-one-arab/replay}"
VERSION="${REPLAY_VERSION:-0.2.3}"
REPLAY_HOME="${REPLAY_HOME:-$HOME/.replay}"
PLATFORM="darwin-arm64"
ARCHIVE="replay-$VERSION-$PLATFORM.tar.gz"
BASE="${REPLAY_RELEASE_BASE:-https://github.com/$GITHUB/releases/download/v$VERSION}"

log() { printf '%s\n' "$*" >&2; }

# --- platform guard ---
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) ;;
  *) log "Replay's runtime is only published for macOS Apple Silicon (darwin-arm64)."; log "You are on $(uname -s) $(uname -m)."; exit 1 ;;
esac

# --- checksum helper (macOS ships shasum; fall back to sha256sum elsewhere) ---
sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else log "Need 'shasum' or 'sha256sum' to verify the download."; exit 1; fi
}

# --- fetch the published sha256 sidecar (shipped next to the archive) ---
log "Replay $VERSION — verifying against published checksum…"
sha=$(curl -fsSL "$BASE/$ARCHIVE.sha256" | cut -d' ' -f1 | head -n1 || true)
[ -n "$sha" ] || {
  log "Could not fetch $BASE/$ARCHIVE.sha256"
  log "Confirm release v$VERSION exists at https://github.com/$GITHUB/releases and the repo is public."
  exit 1
}

# --- download + verify ---
tmp=$(mktemp -d 2>/dev/null || mktemp -d -t replay-install)
trap 'rm -rf "$tmp"' EXIT
archive_file="$tmp/$ARCHIVE"
log "Downloading $BASE/$ARCHIVE …"
curl -fsSL "$BASE/$ARCHIVE" -o "$archive_file"
actual=$(sha256_of "$archive_file")
[ "$actual" = "$sha" ] || { log "Checksum mismatch: expected $sha"; log "                got      $actual"; exit 1; }

# --- extract ---
tar -C "$tmp" -xzf "$archive_file"
src_root="$tmp/replay-$VERSION-$PLATFORM"
[ -d "$src_root" ] || src_root=$(ls -d "$tmp"/replay-*-"$PLATFORM" 2>/dev/null | head -n1 || true)
[ -d "$src_root" ] || { log "Extracted archive did not contain a runtime directory."; exit 1; }
[ -f "$src_root/runtime/bin/replay-mcp" ] || { log "Runtime archive is missing bin/replay-mcp."; exit 1; }

# --- install ---
runtimes_dir="$REPLAY_HOME/runtimes"
dest="$runtimes_dir/$VERSION"
mkdir -p "$runtimes_dir"
if [ -e "$dest" ]; then log "Replacing existing $dest"; rm -rf "$dest"; fi
cp -R "$src_root/runtime" "$dest"
chmod +x "$dest/bin/replay" "$dest/bin/replay-mcp" "$dest/bin/replay-playwright-launcher" 2>/dev/null || true
# Stable symlink so agent configs survive upgrades: current -> <version>.
ln -snf "$VERSION" "$runtimes_dir/current"

bin="$runtimes_dir/current/bin/replay-mcp"

log "Replay $VERSION installed."
log ""

# --- Claude Code: install the skill and register the MCP server ---
# Respect CLAUDE_CONFIG_DIR so a custom home (e.g. ~/.claude-signit) is handled;
# hardcoding ~/.claude would silently drop the skill in the wrong place.
CLAUDE_HOME="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CLAUDE_MCP_CMD="claude mcp add -s user -e REPLAY_SHARE_URL=https://share.replaythis.io replay -- $bin"
if command -v claude >/dev/null 2>&1 || [ -d "$CLAUDE_HOME" ]; then
  mkdir -p "$CLAUDE_HOME/skills"
  rm -rf "$CLAUDE_HOME/skills/replay-browser-capture"
  if cp -R "$src_root/skills/replay-browser-capture" "$CLAUDE_HOME/skills/" 2>/dev/null; then
    log "Installed Replay skill → $CLAUDE_HOME/skills/replay-browser-capture"
  else
    log "Warning: skill was not in the archive; Claude Code gets the tools but not the skill."
  fi
  if command -v claude >/dev/null 2>&1; then
    if claude mcp add -s user -e REPLAY_SHARE_URL=https://share.replaythis.io replay -- "$bin" >/dev/null 2>&1; then
      log "Registered Replay MCP server with Claude Code (user scope)."
    else
      log "Could not auto-register the MCP server (already registered, or the CLI declined). Run:"
      log "  $CLAUDE_MCP_CMD"
    fi
  else
    log "Claude CLI not on PATH. Register the MCP server with:"
    log "  $CLAUDE_MCP_CMD"
  fi
  log "Open a new Claude Code session and invoke the skill with /replay-browser-capture."
else
  log "Claude Code not detected. To use Replay with it later, install the CLI and run:"
  log "  $CLAUDE_MCP_CMD"
fi
log ""
log "For Codex, run:"
log "  codex mcp add replay --env REPLAY_SHARE_URL=https://share.replaythis.io -- $bin"
