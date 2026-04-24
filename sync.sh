#!/bin/bash
# Push markdown docs to Notion.
# Edit .env in this directory to set credentials.
#
# Usage:
#   bash sync.sh
#   bash sync.sh --dry-run
#   bash sync.sh --only jobs
#   bash sync.sh --only jobs/overview.md admin
#   bash sync.sh --dry-run --only system

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: $ENV_FILE not found. Copy .env.example and fill in your credentials."
  exit 1
fi

# Load env vars
set -a
source "$ENV_FILE"
set +a

# Parse --dry-run flag; collect remaining args to forward to bun
BUN_ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--dry-run" ]; then
    export DRY_RUN=1
    echo "Running in dry-run mode (no writes to Notion)"
  else
    BUN_ARGS+=("$arg")
  fi
done

if [ "$NOTION_ROOT_PAGE_ID" = "FILL_THIS_IN" ] || [ -z "$NOTION_ROOT_PAGE_ID" ]; then
  echo "Error: NOTION_ROOT_PAGE_ID is not set in $ENV_FILE"
  echo "Open your target Notion page, copy the ID from the URL, and paste it into .env"
  exit 1
fi

cd "$SCRIPT_DIR"

# Install deps if node_modules is missing
if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  bun install --silent
fi

bun index.ts "${BUN_ARGS[@]}"
