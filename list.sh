#!/bin/bash
# notion-list — read remote Notion page tree, cache, and compare to local docs.
# Subcommands: fetch | show | diff   (default: show, fetching once if needed)
#
# Examples:
#   bash list.sh                     # show cached tree (fetches once if no cache)
#   bash list.sh fetch               # force re-fetch
#   bash list.sh fetch --no-icons    # faster fetch without per-page icons
#   bash list.sh show --empty-only   # only show pages with zero content blocks
#   bash list.sh show --max-depth 2  # collapse beyond depth 2
#   bash list.sh diff                # compare cache vs local docs
#   bash list.sh fix-mentions        # retroactive: convert internal links → native page mentions on every cached page
#   bash list.sh recent-errors       # surface failed paths from recent runs.jsonl entries (default last 5 runs)
#   bash list.sh sitemap             # push 🗺️ Sitemap page summarizing every cached page (mention pills as leaves)
#   bash list.sh tag-index           # push 🏷️ Tags page aggregating frontmatter + body tags across all docs
#   bash list.sh index-db            # push/refresh 📇 Doc Index sidecar Notion database (filterable / sortable view of every doc)
#   bash list.sh backlinks           # append "🔗 Linked from" callout to each page listing other docs that reference it
#   bash list.sh recent-feed         # push 📣 Recently Synced page (last 50 unique syncs from runs.jsonl; --limit N to widen)

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -f .env ]; then
  echo "Error: .env not found in $SCRIPT_DIR"
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  bun install --silent
fi

# OS-aware notification helper (mirrors sync.sh). macOS uses osascript banner;
# always also prints to terminal.
_notify() {
  local title="$1" message="$2" subtitle="${3:-}"
  if [ "$(uname -s)" = "Darwin" ] && command -v osascript &>/dev/null; then
    local title_esc message_esc subtitle_esc
    title_esc=$(printf '%s' "$title" | sed 's/"/\\"/g')
    message_esc=$(printf '%s' "$message" | sed 's/"/\\"/g')
    subtitle_esc=$(printf '%s' "$subtitle" | sed 's/"/\\"/g')
    if [ -n "$subtitle" ]; then
      osascript -e "display notification \"$message_esc\" with title \"$title_esc\" subtitle \"$subtitle_esc\"" 2>/dev/null || true
    else
      osascript -e "display notification \"$message_esc\" with title \"$title_esc\"" 2>/dev/null || true
    fi
  fi
  if command -v gum &>/dev/null; then
    gum style --foreground 212 "🔔  $title — $message${subtitle:+  ($subtitle)}"
  else
    echo "🔔  $title — $message${subtitle:+  ($subtitle)}"
  fi
}

# Parse subcommand for the post-run notification message
SUBCMD="${1:-show}"
[[ "$SUBCMD" == --* ]] && SUBCMD="show"

START_TS=$(date +%s)
EXIT_CODE=0
bun notion-list.ts "$@" || EXIT_CODE=$?
END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))

# Notify only for long-running subcommands (fetch, fix-mentions). show/diff
# usually finish in under 1s — a notification banner is more annoying than
# helpful at that pace.
if [ "$SUBCMD" = "fetch" ] || [ "$SUBCMD" = "fix-mentions" ] || [ "$SUBCMD" = "sitemap" ] || [ "$SUBCMD" = "tag-index" ] || [ "$SUBCMD" = "index-db" ] || [ "$SUBCMD" = "backlinks" ] || [ "$SUBCMD" = "recent-feed" ]; then
  if [ "$EXIT_CODE" -eq 0 ]; then
    _notify "notion-list ✓" "$SUBCMD complete" "${ELAPSED}s"
  else
    _notify "notion-list ✗" "$SUBCMD failed (exit $EXIT_CODE)" "${ELAPSED}s"
  fi
fi

exit $EXIT_CODE
