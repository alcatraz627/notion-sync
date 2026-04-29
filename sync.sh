#!/bin/bash
# Push markdown docs to Notion.
# Edit .env in this directory to set credentials.
#
# Usage:
#   bash sync.sh                   # interactive wizard
#   bash sync.sh --no-wizard       # skip wizard, use saved defaults
#   bash sync.sh --dry-run         # override: force dry run
#   bash sync.sh --only jobs       # override: filter to one section
#   bash sync.sh --verbose         # override: verbose per-file output

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
DEFAULTS_FILE="$SCRIPT_DIR/.sync-defaults.json"

# ── Sanity checks ─────────────────────────────────────────────────────────────

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: $ENV_FILE not found. Copy .env.example and fill in your credentials."
  exit 1
fi

set -a; source "$ENV_FILE"; set +a

if [ "$NOTION_ROOT_PAGE_ID" = "FILL_THIS_IN" ] || [ -z "$NOTION_ROOT_PAGE_ID" ]; then
  echo "Error: NOTION_ROOT_PAGE_ID is not set in $ENV_FILE"
  exit 1
fi

cd "$SCRIPT_DIR"

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  bun install --silent
fi

# ── Default values ─────────────────────────────────────────────────────────────
# Read from saved defaults file; fall back to safe literals.

_load() {
  local key="$1" fallback="$2"
  if [ -f "$DEFAULTS_FILE" ]; then
    python3 -c "
import json, sys
try:
  d = json.load(open('$DEFAULTS_FILE'))
  v = d.get('$key')
  print(str(v) if v is not None else '$fallback')
except Exception:
  print('$fallback')
" 2>/dev/null || echo "$fallback"
  else
    echo "$fallback"
  fi
}

DEF_DRY_RUN="$(_load dry_run false)"
DEF_FILTER="$(_load filter '')"
DEF_ABORT_POLICY="$(_load abort_policy disabled)"
DEF_VERBOSE="$(_load verbose false)"
DEF_LINK_MODE="$(_load link_mode notion)"
DEF_SHOW_META="$(_load show_meta true)"

# ── Parse CLI override flags ──────────────────────────────────────────────────

OVERRIDE_DRY_RUN=""
OVERRIDE_FILTER=""
OVERRIDE_VERBOSE=""
NO_WIZARD=false
BUN_EXTRA_ARGS=()
COLLECTING_ONLY=false

for arg in "$@"; do
  if [ "$arg" = "--no-wizard" ]; then
    NO_WIZARD=true
  elif [ "$arg" = "--dry-run" ]; then
    OVERRIDE_DRY_RUN=true
  elif [ "$arg" = "--verbose" ]; then
    OVERRIDE_VERBOSE=true
  elif [ "$arg" = "--only" ]; then
    COLLECTING_ONLY=true
  elif [ "$COLLECTING_ONLY" = true ]; then
    if [[ "$arg" == --* ]]; then
      COLLECTING_ONLY=false
      BUN_EXTRA_ARGS+=("$arg")
    else
      OVERRIDE_FILTER="${OVERRIDE_FILTER:+$OVERRIDE_FILTER }$arg"
      BUN_EXTRA_ARGS+=("$arg")
    fi
  else
    BUN_EXTRA_ARGS+=("$arg")
  fi
done

# ── Discover available sections ───────────────────────────────────────────────

EFFECTIVE_DOCS_DIR="${DOCS_DIR:-$SCRIPT_DIR/docs}"
SECTION_LIST=()
if [ -d "$EFFECTIVE_DOCS_DIR" ]; then
  while IFS= read -r dir; do
    SECTION_LIST+=("$(basename "$dir")")
  done < <(find "$EFFECTIVE_DOCS_DIR" -maxdepth 1 -mindepth 1 -type d | sort)
fi

# ── Wizard ────────────────────────────────────────────────────────────────────

WIZARD_AVAILABLE=false
if command -v gum &>/dev/null && [ -t 0 ] && [ -t 1 ] && [ "$NO_WIZARD" = false ]; then
  WIZARD_AVAILABLE=true
fi

if [ "$WIZARD_AVAILABLE" = true ]; then
  gum style \
    --border rounded \
    --border-foreground 212 \
    --bold \
    --padding "0 2" \
    "  notion-sync"

  echo ""

  # ── Dry run ──
  # --default means "Yes is the default". Omitting the flag means "No is the default".
  # --no-default is NOT a valid gum flag (exits 80 + prints help to stdout).
  DRY_PROMPT="Dry run? (no writes to Notion)"
  DRY_DEFAULT_FLAG=""
  { [ "$DEF_DRY_RUN" = "True" ] || [ "$DEF_DRY_RUN" = "true" ]; } && DRY_DEFAULT_FLAG="--default"
  if gum confirm "$DRY_PROMPT" $DRY_DEFAULT_FLAG --affirmative="Yes (preview)" --negative="No (live sync)"; then
    CHOSEN_DRY_RUN=true
  else
    CHOSEN_DRY_RUN=false
  fi

  # ── Section filter ──
  echo ""
  if [ ${#SECTION_LIST[@]} -gt 0 ]; then
    gum style --foreground 245 "Section filter — space to toggle, enter to confirm (none = sync all)"
    # Convert space/comma-separated DEF_FILTER into comma-separated for --selected
    DEF_FILTER_CSV=$(echo "$DEF_FILTER" | tr ' ' ',')
    FILTER_RAW=$(printf '%s\n' "${SECTION_LIST[@]}" | \
      gum choose --no-limit --selected="$DEF_FILTER_CSV" --height=14 \
      || echo "")
    # Convert newline-separated gum output to space-separated filter string
    CHOSEN_FILTER=$(echo "$FILTER_RAW" | tr '\n' ' ' | xargs)
  else
    gum style --foreground 245 "Section filter — leave blank to sync all sections"
    CHOSEN_FILTER=$(gum input \
      --placeholder "e.g. jobs, admin, boring-technical-stuff (blank = all)" \
      --value "$DEF_FILTER" \
      --width 60 \
      || echo "$DEF_FILTER")
  fi

  # ── Abort policy ──
  echo ""
  gum style --foreground 245 "Abort policy — stop early if many consecutive errors?"
  ABORT_OPTIONS=(
    "disabled — run all files, collect all errors"
    "1 error  — abort on first failure"
    "2 errors — abort if 2+ failures in last 10"
    "3 errors — abort if 3+ failures in last 10"
    "5 errors — abort if 5+ failures in last 10"
    "10 errors — abort if 10+ failures in last 20"
  )
  case "$DEF_ABORT_POLICY" in
    1)  ABORT_SELECTED="${ABORT_OPTIONS[1]}" ;;
    2)  ABORT_SELECTED="${ABORT_OPTIONS[2]}" ;;
    3)  ABORT_SELECTED="${ABORT_OPTIONS[3]}" ;;
    5)  ABORT_SELECTED="${ABORT_OPTIONS[4]}" ;;
    10) ABORT_SELECTED="${ABORT_OPTIONS[5]}" ;;
    *)  ABORT_SELECTED="${ABORT_OPTIONS[0]}" ;;
  esac
  ABORT_CHOICE=$(printf '%s\n' "${ABORT_OPTIONS[@]}" | \
    gum choose --selected="$ABORT_SELECTED" --height=8 || echo "$ABORT_SELECTED")
  case "$ABORT_CHOICE" in
    "1 error"*)   CHOSEN_ABORT_POLICY=1 ;;
    "2 errors"*)  CHOSEN_ABORT_POLICY=2 ;;
    "3 errors"*)  CHOSEN_ABORT_POLICY=3 ;;
    "5 errors"*)  CHOSEN_ABORT_POLICY=5 ;;
    "10 errors"*) CHOSEN_ABORT_POLICY=10 ;;
    *)            CHOSEN_ABORT_POLICY=disabled ;;
  esac

  # ── Verbose output ──
  echo ""
  VERBOSE_PROMPT="Verbose output? (per-file detail instead of progress bar)"
  VERBOSE_DEFAULT_FLAG=""
  { [ "$DEF_VERBOSE" = "True" ] || [ "$DEF_VERBOSE" = "true" ]; } && VERBOSE_DEFAULT_FLAG="--default"
  if gum confirm "$VERBOSE_PROMPT" $VERBOSE_DEFAULT_FLAG; then
    CHOSEN_VERBOSE=true
  else
    CHOSEN_VERBOSE=false
  fi

  # ── Link mode ──
  echo ""
  gum style --foreground 245 "Link mode — how to rewrite relative .md links in Notion"
  LINK_OPTIONS=(
    "notion — rewrite to Notion page URLs (recommended)"
    "github — rewrite to GitHub blob URLs"
    "strip  — remove links, keep plain text"
  )
  case "$DEF_LINK_MODE" in
    github) LINK_SELECTED="${LINK_OPTIONS[1]}" ;;
    strip)  LINK_SELECTED="${LINK_OPTIONS[2]}" ;;
    *)      LINK_SELECTED="${LINK_OPTIONS[0]}" ;;
  esac
  LINK_CHOICE=$(printf '%s\n' "${LINK_OPTIONS[@]}" | \
    gum choose --selected="$LINK_SELECTED" --height=5 || echo "$LINK_SELECTED")
  case "$LINK_CHOICE" in
    "github"*) CHOSEN_LINK_MODE=github ;;
    "strip"*)  CHOSEN_LINK_MODE=strip ;;
    *)         CHOSEN_LINK_MODE=notion ;;
  esac

  # ── Show meta banner ──
  echo ""
  META_PROMPT="Show metadata banner? (frontmatter summary at top of each Notion page)"
  META_DEFAULT_FLAG=""
  { [ "$DEF_SHOW_META" = "True" ] || [ "$DEF_SHOW_META" = "true" ]; } && META_DEFAULT_FLAG="--default"
  if gum confirm "$META_PROMPT" $META_DEFAULT_FLAG; then
    CHOSEN_SHOW_META=true
  else
    CHOSEN_SHOW_META=false
  fi

  echo ""
  gum style --border normal --border-foreground 238 --padding "0 1" \
    "$(gum style --foreground 10 --bold "  Ready to sync")
  Dry run:        $CHOSEN_DRY_RUN
  Filter:         ${CHOSEN_FILTER:-all sections}
  Abort policy:   $CHOSEN_ABORT_POLICY
  Verbose:        $CHOSEN_VERBOSE
  Link mode:      $CHOSEN_LINK_MODE
  Show meta:      $CHOSEN_SHOW_META"

  echo ""
  if ! gum confirm "Proceed?" --affirmative="Yes, sync" --negative="Cancel"; then
    gum style --foreground 245 "Cancelled."
    exit 0
  fi

  # Apply overrides from CLI flags (take priority over wizard)
  [ -n "$OVERRIDE_DRY_RUN" ] && CHOSEN_DRY_RUN=$OVERRIDE_DRY_RUN
  [ -n "$OVERRIDE_VERBOSE" ] && CHOSEN_VERBOSE=$OVERRIDE_VERBOSE

else
  # Non-interactive / --no-wizard: use saved defaults + CLI overrides
  CHOSEN_DRY_RUN="${OVERRIDE_DRY_RUN:-$DEF_DRY_RUN}"
  CHOSEN_FILTER="${OVERRIDE_FILTER:-$DEF_FILTER}"
  CHOSEN_ABORT_POLICY="$DEF_ABORT_POLICY"
  CHOSEN_VERBOSE="${OVERRIDE_VERBOSE:-$DEF_VERBOSE}"
  CHOSEN_LINK_MODE="$DEF_LINK_MODE"
  CHOSEN_SHOW_META="$DEF_SHOW_META"

  if [ "$NO_WIZARD" = false ] && [ -f "$DEFAULTS_FILE" ]; then
    echo "notion-sync: using saved defaults (run with a TTY for the interactive wizard)"
  fi
fi

# ── Save defaults ─────────────────────────────────────────────────────────────

python3 - << PYEOF
import json
def to_bool(s):
    return str(s).lower() in ("true", "1", "yes")
data = {
    "dry_run":      to_bool("${CHOSEN_DRY_RUN}"),
    "filter":       "${CHOSEN_FILTER}",
    "abort_policy": "${CHOSEN_ABORT_POLICY}",
    "verbose":      to_bool("${CHOSEN_VERBOSE}"),
    "link_mode":    "${CHOSEN_LINK_MODE}",
    "show_meta":    to_bool("${CHOSEN_SHOW_META}"),
}
with open("$DEFAULTS_FILE", "w") as f:
    json.dump(data, f, indent=2)
PYEOF

# ── Export env vars ───────────────────────────────────────────────────────────

[ "$CHOSEN_DRY_RUN" = "true" ] || [ "$CHOSEN_DRY_RUN" = "True" ] && export DRY_RUN=1 || export DRY_RUN=0
[ "$CHOSEN_VERBOSE" = "true" ] || [ "$CHOSEN_VERBOSE" = "True" ] && export VERBOSE=1 || export VERBOSE=0
export ABORT_POLICY="$CHOSEN_ABORT_POLICY"
export NOTION_LINK_MODE="$CHOSEN_LINK_MODE"
[ "$CHOSEN_SHOW_META" = "true" ] || [ "$CHOSEN_SHOW_META" = "True" ] && export NOTION_SHOW_META=1 || export NOTION_SHOW_META=0

# Build --only args from filter string
ONLY_ARGS=()
if [ -n "$CHOSEN_FILTER" ] && [ -z "$OVERRIDE_FILTER" ]; then
  ONLY_ARGS+=("--only")
  # Split on spaces/commas
  IFS=', ' read -ra FILTER_PARTS <<< "$CHOSEN_FILTER"
  ONLY_ARGS+=("${FILTER_PARTS[@]}")
fi

# ── Run ───────────────────────────────────────────────────────────────────────

bun index.ts "${ONLY_ARGS[@]}" "${BUN_EXTRA_ARGS[@]}"
