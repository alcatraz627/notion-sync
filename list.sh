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

bun notion-list.ts "$@"
