#!/bin/bash
# notion-sync — push markdown docs to a Notion workspace
# Run with -h for help.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
DEFAULTS_FILE="$SCRIPT_DIR/.sync-defaults.json"

# ── Shared helpers ────────────────────────────────────────────────────────────

# Print a styled or plain section header (used in both help and wizard)
_section() {
  if command -v gum &>/dev/null; then
    gum style --bold --foreground 212 "$1"
  else
    echo "$1"
  fi
}

# Called on Ctrl+C — always exits 130
_cancelled() {
  echo ""
  if command -v gum &>/dev/null; then
    gum style --foreground 245 "Cancelled."
  else
    echo "Cancelled."
  fi
  exit 130
}

# OS-aware notification. macOS uses osascript (visible Notification Center
# banner); other systems print a styled warn line. Title + message + optional
# subtitle. Never blocks; never errors out (any failure → silent fallback).
_notify() {
  local title="$1" message="$2" subtitle="${3:-}"
  if [ "$(uname -s)" = "Darwin" ] && command -v osascript &>/dev/null; then
    # Escape double quotes for AppleScript
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
  # Always also print to terminal — the notification can be dismissed before reading
  if command -v gum &>/dev/null; then
    gum style --foreground 212 "🔔  $title — $message${subtitle:+  ($subtitle)}"
  else
    echo "🔔  $title — $message${subtitle:+  ($subtitle)}"
  fi
}

# Pretty error printer — bold red, optional hint line.
_err() {
  if command -v gum &>/dev/null; then
    gum style --foreground 1 --bold "  ✗ $1"
    [ -n "$2" ] && gum style --foreground 245 "    $2"
  else
    echo "  ✗ $1"
    [ -n "$2" ] && echo "    $2"
  fi
}

# ── Help ──────────────────────────────────────────────────────────────────────

show_help() {
  if command -v gum &>/dev/null; then
    gum style --border rounded --border-foreground 212 --bold --padding "0 2" \
      "  notion-sync"
    echo ""
  fi

  local R='\033[0m' B='\033[1m' D='\033[2m'
  _row()  { printf "  ${B}%-26s${R} %s\n" "$1" "$2"; }
  _rowD() { printf "  ${D}%-26s${R} %s\n" "$1" "$2"; }

  _section "USAGE"
  echo "  bash sync.sh [OPTIONS]"
  echo ""

  _section "MODES"
  _row  "(default)"              "Sync local docs → Notion"
  _row  "--fix-mentions"         "Convert all already-synced internal links → page mentions"
  echo ""

  _section "OPTIONS"
  _row  "-h, --help"             "Show this help screen"
  _row  "--no-wizard"            "Skip wizard, use saved defaults"
  _row  "--dry-run"              "Preview without writing to Notion"
  _row  "--only <section> [...]" "Sync only the named section(s)"
  _row  "--verbose"              "Per-file output instead of progress bar"
  echo ""

  _section "ENVIRONMENT  (.env)"
  _row  "NOTION_TOKEN"           "Integration secret — required"
  _row  "NOTION_ROOT_PAGE_ID"    "Root page ID or URL — required"
  _rowD "DOCS_DIR"               "Docs folder (default: ./docs)"
  _rowD "GITHUB_REPO"            "owner/repo for link fallback URLs"
  _rowD "NOTION_LINK_MODE"       "notion | github | strip  (default: notion)"
  _rowD "NOTION_SHOW_META"       "1|0 — frontmatter banner  (default: 1)"
  _rowD "NOTION_UPLOAD_IMAGES"   "1 — upload images to Notion CDN (private-repo support)"
  _rowD "NOTION_USE_MENTIONS"    "0 — disable internal-link → mention conversion (default ON)"
  echo ""

  _section "EXAMPLES"
  echo "  bash sync.sh                           # interactive wizard"
  echo "  bash sync.sh --no-wizard               # use saved defaults"
  echo "  bash sync.sh --dry-run                 # preview only"
  echo "  bash sync.sh --only boring-technical-stuff"
  echo "  bash sync.sh --only jobs workflows --verbose"
  echo "  bash sync.sh --fix-mentions            # retro-fix internal links on synced pages"
  echo ""

  _section "WIZARD"
  echo "  Requires gum (https://github.com/charmbracelet/gum)"
  echo "  Selections are saved to .sync-defaults.json (gitignored)"
  echo "  Ctrl+C at any prompt quits immediately"
}

# Handle -h before anything else so it works without a configured .env
for arg in "$@"; do
  if [ "$arg" = "-h" ] || [ "$arg" = "--help" ]; then
    show_help
    exit 0
  fi
done

# ── Pre-flight env validation ─────────────────────────────────────────────────
# Surface every problem at once, with hints, BEFORE the wizard. The Node script
# also validates, but doing it here means the user doesn't sit through the
# wizard only to fail at the very end.

_validate_env() {
  local issues=0

  # .env exists at all?
  if [ ! -f "$ENV_FILE" ]; then
    _err ".env not found at $ENV_FILE" "Copy .env.example and fill in NOTION_TOKEN + NOTION_ROOT_PAGE_ID"
    return 1
  fi

  # Source it
  set -a; source "$ENV_FILE"; set +a

  # NOTION_TOKEN
  if [ -z "$NOTION_TOKEN" ] || [ "$NOTION_TOKEN" = "FILL_THIS_IN" ]; then
    _err "NOTION_TOKEN is not set in .env"
    issues=$((issues + 1))
  elif ! [[ "$NOTION_TOKEN" =~ ^(secret_|ntn_) ]]; then
    _err "NOTION_TOKEN looks malformed (got: ${NOTION_TOKEN:0:8}...)" \
         "Should start with 'secret_' or 'ntn_' — get one at https://www.notion.so/my-integrations"
    issues=$((issues + 1))
  fi

  # NOTION_ROOT_PAGE_ID
  if [ -z "$NOTION_ROOT_PAGE_ID" ] || [ "$NOTION_ROOT_PAGE_ID" = "FILL_THIS_IN" ]; then
    _err "NOTION_ROOT_PAGE_ID is not set in .env"
    issues=$((issues + 1))
  elif ! [[ "$NOTION_ROOT_PAGE_ID" =~ [0-9a-fA-F]{32} ]]; then
    _err "NOTION_ROOT_PAGE_ID doesn't contain a 32-hex page ID (got: $NOTION_ROOT_PAGE_ID)" \
         "Should be a Notion URL like 'My-Page-abcdef0123456789...' or just the 32-hex ID"
    issues=$((issues + 1))
  fi

  # DOCS_DIR
  local effective_docs_dir="${DOCS_DIR:-$SCRIPT_DIR/docs}"
  if [ ! -d "$effective_docs_dir" ]; then
    _err "DOCS_DIR does not exist: $effective_docs_dir" \
         "Set DOCS_DIR=/abs/path/to/your/docs in .env (or create the default ./docs)"
    issues=$((issues + 1))
  fi

  # GITHUB_REPO format if set
  if [ -n "$GITHUB_REPO" ] && ! [[ "$GITHUB_REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]; then
    _err "GITHUB_REPO format invalid: '$GITHUB_REPO'" \
         "Should be 'owner/repo' (no leading https:// or trailing /)"
    issues=$((issues + 1))
  fi

  # GITHUB_DOC_SOURCE_URL_BASE format if set
  if [ -n "$GITHUB_DOC_SOURCE_URL_BASE" ] && ! [[ "$GITHUB_DOC_SOURCE_URL_BASE" =~ ^https?:// ]]; then
    _err "GITHUB_DOC_SOURCE_URL_BASE should be a full URL: '$GITHUB_DOC_SOURCE_URL_BASE'" \
         "e.g. https://github.com/owner/repo/blob/main/docs"
    issues=$((issues + 1))
  fi

  if [ "$issues" -gt 0 ]; then
    echo ""
    _err "$issues configuration problem(s) found — fix the above before running."
    return 1
  fi

  return 0
}

if ! _validate_env; then
  exit 1
fi

cd "$SCRIPT_DIR"

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  bun install --silent
fi

# ── Load saved defaults ────────────────────────────────────────────────────────

_load() {
  local key="$1" fallback="$2"
  if [ -f "$DEFAULTS_FILE" ]; then
    python3 -c "
import json
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

# Better defaults: dry_run defaults to FALSE (most invocations are live syncs).
# upload_images and use_mentions default to TRUE — both strictly improve output
# quality for private-repo users (the common case).
DEF_MODE="$(_load mode sync)"
DEF_DRY_RUN="$(_load dry_run false)"
DEF_FILTER="$(_load filter '')"
DEF_ABORT_POLICY="$(_load abort_policy disabled)"
DEF_VERBOSE="$(_load verbose false)"
DEF_LINK_MODE="$(_load link_mode notion)"
DEF_SHOW_META="$(_load show_meta true)"
DEF_UPLOAD_IMAGES="$(_load upload_images true)"
DEF_USE_MENTIONS="$(_load use_mentions true)"

# ── Parse CLI flags ───────────────────────────────────────────────────────────

OVERRIDE_DRY_RUN=""
OVERRIDE_FILTER=""
OVERRIDE_VERBOSE=""
OVERRIDE_MODE=""
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
  elif [ "$arg" = "--fix-mentions" ]; then
    OVERRIDE_MODE=fix-mentions
  elif [ "$arg" = "--only" ]; then
    COLLECTING_ONLY=true
  elif [ "$COLLECTING_ONLY" = true ]; then
    if [[ "$arg" == --* ]]; then
      COLLECTING_ONLY=false
      BUN_EXTRA_ARGS+=("$arg")
    else
      OVERRIDE_FILTER="${OVERRIDE_FILTER:+$OVERRIDE_FILTER }$arg"
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
if command -v gum &>/dev/null && [ -t 0 ] && [ -t 1 ] && [ "$NO_WIZARD" = false ] && [ -z "$OVERRIDE_MODE" ]; then
  WIZARD_AVAILABLE=true
fi

# Gum confirm helper that respects ctrl-c (gum returns 130) and accepts a
# default-flag positional. Sets the named variable to true/false.
_confirm() {
  local var="$1" prompt="$2" default_yes="$3" yes_label="${4:-Yes}" no_label="${5:-No}"
  local default_flag=""
  if [ "$default_yes" = "true" ] || [ "$default_yes" = "True" ]; then
    default_flag="--default"
  fi
  local rc=0
  gum confirm "$prompt" $default_flag --affirmative="$yes_label" --negative="$no_label" || rc=$?
  [ $rc -eq 130 ] && _cancelled
  if [ $rc -eq 0 ]; then
    eval "$var=true"
  else
    eval "$var=false"
  fi
}

if [ "$WIZARD_AVAILABLE" = true ]; then
  gum style \
    --border rounded \
    --border-foreground 212 \
    --bold \
    --padding "0 2" \
    "  notion-sync"

  echo ""

  # ── Mode ──
  gum style --foreground 245 "What would you like to do?"
  MODE_OPTIONS=(
    "sync           — push local docs → Notion"
    "fix-mentions   — convert internal links → page mentions on already-synced pages"
  )
  case "$DEF_MODE" in
    fix-mentions) MODE_SELECTED="${MODE_OPTIONS[1]}" ;;
    *)            MODE_SELECTED="${MODE_OPTIONS[0]}" ;;
  esac
  gum_ec=0
  MODE_CHOICE=$(printf '%s\n' "${MODE_OPTIONS[@]}" | \
    gum choose --selected="$MODE_SELECTED" --height=4) || gum_ec=$?
  [ $gum_ec -eq 130 ] && _cancelled
  [ $gum_ec -ne 0 ] && MODE_CHOICE="$MODE_SELECTED"
  case "$MODE_CHOICE" in
    "fix-mentions"*) CHOSEN_MODE=fix-mentions ;;
    *)               CHOSEN_MODE=sync ;;
  esac

  if [ "$CHOSEN_MODE" = "fix-mentions" ]; then
    # Fix-mentions has no other options — just confirm
    echo ""
    gum style --border normal --border-foreground 238 --padding "0 1" \
      "$(gum style --foreground 10 --bold "  Ready to fix mentions")
  Walks every page in .notion-cache.json and rewrites internal hyperlinks
  to native page mentions. Idempotent — safe to re-run."
    echo ""
    gum_ec=0
    gum confirm "Proceed?" --default --affirmative="Yes, fix" --negative="Cancel" || gum_ec=$?
    [ $gum_ec -eq 130 ] && _cancelled
    [ $gum_ec -ne 0 ] && { gum style --foreground 245 "Cancelled."; exit 0; }

    # Save the chosen mode + run
    python3 - << PYEOF
import json, os
data = {}
try:
  data = json.load(open("$DEFAULTS_FILE"))
except Exception: pass
data["mode"] = "fix-mentions"
with open("$DEFAULTS_FILE", "w") as f:
  json.dump(data, f, indent=2)
PYEOF

    START_TS=$(date +%s)
    bash list.sh fix-mentions
    END_TS=$(date +%s)
    ELAPSED=$((END_TS - START_TS))
    _notify "notion-sync" "fix-mentions complete" "$((ELAPSED))s"
    exit 0
  fi

  # ── Dry run (default NO — most runs are live) ──
  echo ""
  _confirm CHOSEN_DRY_RUN \
    "Dry run? (preview only — no writes to Notion)" \
    "$DEF_DRY_RUN" \
    "Yes (preview)" \
    "No (live sync)"

  # ── Section filter ──
  echo ""
  gum_ec=0
  if [ ${#SECTION_LIST[@]} -gt 0 ]; then
    gum style --foreground 245 "Section filter — space/enter to toggle, ctrl+c to quit (blank = all)"
    DEF_FILTER_CSV=$(echo "$DEF_FILTER" | tr ' ' ',')
    FILTER_RAW=$(printf '%s\n' "${SECTION_LIST[@]}" | \
      gum choose --no-limit --selected="$DEF_FILTER_CSV" --height=14) || gum_ec=$?
    [ $gum_ec -eq 130 ] && _cancelled
    [ $gum_ec -ne 0 ] && FILTER_RAW=""
    CHOSEN_FILTER=$(echo "$FILTER_RAW" | tr '\n' ' ' | xargs)
  else
    gum style --foreground 245 "Section filter — blank = sync all sections"
    CHOSEN_FILTER=$(gum input \
      --placeholder "e.g. jobs admin boring-technical-stuff  (blank = all)" \
      --value "$DEF_FILTER" \
      --width 64) || gum_ec=$?
    [ $gum_ec -eq 130 ] && _cancelled
    [ $gum_ec -ne 0 ] && CHOSEN_FILTER="$DEF_FILTER"
  fi

  # ── Upload images? ──
  echo ""
  _confirm CHOSEN_UPLOAD_IMAGES \
    "Upload images to Notion CDN? (required for private GitHub repos)" \
    "$DEF_UPLOAD_IMAGES" \
    "Yes (upload + cache)" \
    "No (use raw GitHub URLs)"

  # ── Use mentions? ──
  echo ""
  _confirm CHOSEN_USE_MENTIONS \
    "Convert internal links to native page mentions? (inline pills, hover-preview)" \
    "$DEF_USE_MENTIONS" \
    "Yes (mentions)" \
    "No (regular links)"

  # ── Verbose output ──
  echo ""
  _confirm CHOSEN_VERBOSE \
    "Verbose output? (per-file detail instead of progress bar)" \
    "$DEF_VERBOSE" \
    "Yes (verbose)" \
    "No (progress bar)"

  # ── Show meta banner ──
  echo ""
  _confirm CHOSEN_SHOW_META \
    "Show metadata banner? (frontmatter summary at top of each page)" \
    "$DEF_SHOW_META" \
    "Yes (banner)" \
    "No"

  # ── Link mode ──
  echo ""
  gum style --foreground 245 "Link mode — how to rewrite relative .md links"
  LINK_OPTIONS=(
    "notion — Notion page URLs (recommended)"
    "github — GitHub blob URLs"
    "strip  — plain text, no links"
  )
  case "$DEF_LINK_MODE" in
    github) LINK_SELECTED="${LINK_OPTIONS[1]}" ;;
    strip)  LINK_SELECTED="${LINK_OPTIONS[2]}" ;;
    *)      LINK_SELECTED="${LINK_OPTIONS[0]}" ;;
  esac
  gum_ec=0
  LINK_CHOICE=$(printf '%s\n' "${LINK_OPTIONS[@]}" | \
    gum choose --selected="$LINK_SELECTED" --height=5) || gum_ec=$?
  [ $gum_ec -eq 130 ] && _cancelled
  [ $gum_ec -ne 0 ] && LINK_CHOICE="$LINK_SELECTED"
  case "$LINK_CHOICE" in
    "github"*) CHOSEN_LINK_MODE=github ;;
    "strip"*)  CHOSEN_LINK_MODE=strip ;;
    *)         CHOSEN_LINK_MODE=notion ;;
  esac

  # ── Abort policy ──
  echo ""
  gum style --foreground 245 "Abort policy — stop early on consecutive errors?"
  ABORT_OPTIONS=(
    "disabled  — run everything, collect all errors"
    "1 error   — stop on first failure"
    "2 errors  — stop if 2+ failures in last 10"
    "3 errors  — stop if 3+ failures in last 10"
    "5 errors  — stop if 5+ failures in last 10"
    "10 errors — stop if 10+ failures in last 20"
  )
  case "$DEF_ABORT_POLICY" in
    1)  ABORT_SELECTED="${ABORT_OPTIONS[1]}" ;;
    2)  ABORT_SELECTED="${ABORT_OPTIONS[2]}" ;;
    3)  ABORT_SELECTED="${ABORT_OPTIONS[3]}" ;;
    5)  ABORT_SELECTED="${ABORT_OPTIONS[4]}" ;;
    10) ABORT_SELECTED="${ABORT_OPTIONS[5]}" ;;
    *)  ABORT_SELECTED="${ABORT_OPTIONS[0]}" ;;
  esac
  gum_ec=0
  ABORT_CHOICE=$(printf '%s\n' "${ABORT_OPTIONS[@]}" | \
    gum choose --selected="$ABORT_SELECTED" --height=8) || gum_ec=$?
  [ $gum_ec -eq 130 ] && _cancelled
  [ $gum_ec -ne 0 ] && ABORT_CHOICE="$ABORT_SELECTED"
  case "$ABORT_CHOICE" in
    "1 error"*)   CHOSEN_ABORT_POLICY=1 ;;
    "2 errors"*)  CHOSEN_ABORT_POLICY=2 ;;
    "3 errors"*)  CHOSEN_ABORT_POLICY=3 ;;
    "5 errors"*)  CHOSEN_ABORT_POLICY=5 ;;
    "10 errors"*) CHOSEN_ABORT_POLICY=10 ;;
    *)            CHOSEN_ABORT_POLICY=disabled ;;
  esac

  # ── Summary + final confirm ──
  echo ""
  gum style --border normal --border-foreground 238 --padding "0 1" \
    "$(gum style --foreground 10 --bold "  Ready to sync")
  Mode:           sync
  Dry run:        $CHOSEN_DRY_RUN
  Filter:         ${CHOSEN_FILTER:-all sections}
  Upload images:  $CHOSEN_UPLOAD_IMAGES
  Use mentions:   $CHOSEN_USE_MENTIONS
  Verbose:        $CHOSEN_VERBOSE
  Show meta:      $CHOSEN_SHOW_META
  Link mode:      $CHOSEN_LINK_MODE
  Abort policy:   $CHOSEN_ABORT_POLICY"

  echo ""
  gum_ec=0
  gum confirm "Proceed?" --default --affirmative="Yes, sync" --negative="Cancel" || gum_ec=$?
  [ $gum_ec -eq 130 ] && _cancelled
  if [ $gum_ec -ne 0 ]; then
    gum style --foreground 245 "Cancelled."
    exit 0
  fi

  # CLI overrides take priority over wizard values
  [ -n "$OVERRIDE_DRY_RUN" ] && CHOSEN_DRY_RUN=$OVERRIDE_DRY_RUN
  [ -n "$OVERRIDE_VERBOSE" ] && CHOSEN_VERBOSE=$OVERRIDE_VERBOSE
  CHOSEN_MODE=sync

else
  # Non-interactive / --no-wizard / --fix-mentions: saved defaults + CLI overrides
  if [ "$OVERRIDE_MODE" = "fix-mentions" ]; then
    CHOSEN_MODE=fix-mentions
    START_TS=$(date +%s)
    bash list.sh fix-mentions
    END_TS=$(date +%s)
    ELAPSED=$((END_TS - START_TS))
    _notify "notion-sync" "fix-mentions complete" "$((ELAPSED))s"
    exit 0
  fi

  CHOSEN_MODE=sync
  CHOSEN_DRY_RUN="${OVERRIDE_DRY_RUN:-$DEF_DRY_RUN}"
  CHOSEN_FILTER="${OVERRIDE_FILTER:-$DEF_FILTER}"
  CHOSEN_ABORT_POLICY="$DEF_ABORT_POLICY"
  CHOSEN_VERBOSE="${OVERRIDE_VERBOSE:-$DEF_VERBOSE}"
  CHOSEN_LINK_MODE="$DEF_LINK_MODE"
  CHOSEN_SHOW_META="$DEF_SHOW_META"
  CHOSEN_UPLOAD_IMAGES="$DEF_UPLOAD_IMAGES"
  CHOSEN_USE_MENTIONS="$DEF_USE_MENTIONS"

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
    "mode":           "${CHOSEN_MODE}",
    "dry_run":        to_bool("${CHOSEN_DRY_RUN}"),
    "filter":         "${CHOSEN_FILTER}",
    "abort_policy":   "${CHOSEN_ABORT_POLICY}",
    "verbose":        to_bool("${CHOSEN_VERBOSE}"),
    "link_mode":      "${CHOSEN_LINK_MODE}",
    "show_meta":      to_bool("${CHOSEN_SHOW_META}"),
    "upload_images":  to_bool("${CHOSEN_UPLOAD_IMAGES}"),
    "use_mentions":   to_bool("${CHOSEN_USE_MENTIONS}"),
}
with open("$DEFAULTS_FILE", "w") as f:
    json.dump(data, f, indent=2)
PYEOF

# ── Export env vars for bun ───────────────────────────────────────────────────

if [ "$CHOSEN_DRY_RUN" = "true" ] || [ "$CHOSEN_DRY_RUN" = "True" ]; then
  export DRY_RUN=1
else
  export DRY_RUN=0
fi
if [ "$CHOSEN_VERBOSE" = "true" ] || [ "$CHOSEN_VERBOSE" = "True" ]; then
  export VERBOSE=1
else
  export VERBOSE=0
fi
if [ "$CHOSEN_SHOW_META" = "true" ] || [ "$CHOSEN_SHOW_META" = "True" ]; then
  export NOTION_SHOW_META=1
else
  export NOTION_SHOW_META=0
fi
if [ "$CHOSEN_UPLOAD_IMAGES" = "true" ] || [ "$CHOSEN_UPLOAD_IMAGES" = "True" ]; then
  export NOTION_UPLOAD_IMAGES=1
else
  export NOTION_UPLOAD_IMAGES=0
fi
if [ "$CHOSEN_USE_MENTIONS" = "true" ] || [ "$CHOSEN_USE_MENTIONS" = "True" ]; then
  export NOTION_USE_MENTIONS=1
else
  export NOTION_USE_MENTIONS=0
fi
export ABORT_POLICY="$CHOSEN_ABORT_POLICY"
export NOTION_LINK_MODE="$CHOSEN_LINK_MODE"

# ── Build --only args from filter ─────────────────────────────────────────────

ONLY_ARGS=()
if [ -n "$CHOSEN_FILTER" ]; then
  ONLY_ARGS+=("--only")
  IFS=', ' read -ra FILTER_PARTS <<< "$CHOSEN_FILTER"
  ONLY_ARGS+=("${FILTER_PARTS[@]}")
fi

# ── Run ───────────────────────────────────────────────────────────────────────

START_TS=$(date +%s)
SYNC_EXIT=0
bun index.ts "${ONLY_ARGS[@]}" "${BUN_EXTRA_ARGS[@]}" || SYNC_EXIT=$?
END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))

# ── Post-run notification ─────────────────────────────────────────────────────
# Read the latest entry from runs.jsonl to get accurate stats. If parsing fails
# (no log written, malformed line), fall back to a generic exit-code summary.

NOTIF_TITLE="notion-sync"
if [ "$SYNC_EXIT" -eq 0 ]; then
  NOTIF_TITLE="notion-sync ✓"
else
  NOTIF_TITLE="notion-sync ✗ (exit $SYNC_EXIT)"
fi

if [ -f "$SCRIPT_DIR/runs.jsonl" ]; then
  STATS=$(RUNS_PATH="$SCRIPT_DIR/runs.jsonl" python3 - << 'PYEOF' 2>/dev/null
import json, os
try:
    path = os.environ["RUNS_PATH"]
    with open(path) as f:
        lines = [l for l in f if l.strip()]
    d = json.loads(lines[-1]) if lines else {}
    s = d.get("stats", {}) or {}
    parts = [f"total {s.get('total',0)}", f"created {s.get('created',0)}", f"updated {s.get('updated',0)}"]
    if s.get("errors", 0):
        parts.append(f"errors {s.get('errors')}")
    print(", ".join(parts))
except Exception:
    print("")
PYEOF
)
  if [ -n "$STATS" ]; then
    _notify "$NOTIF_TITLE" "$STATS" "${ELAPSED}s"
  else
    _notify "$NOTIF_TITLE" "completed" "${ELAPSED}s"
  fi
else
  _notify "$NOTIF_TITLE" "completed" "${ELAPSED}s"
fi

exit $SYNC_EXIT
