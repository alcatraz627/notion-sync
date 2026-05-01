#!/bin/bash
# run.sh — pipeline-first launcher for notion-sync.
#
# Treats common workflows as first-class modes instead of asking the user to
# remember which combination of sync.sh / list.sh subcommands to chain. Each
# mode is a sequence of phases; phases call into the existing scripts so
# this stays a thin orchestrator.
#
# Usage:
#   bash run.sh                  # interactive — pick a mode
#   bash run.sh <mode>           # run mode directly
#   bash run.sh -h | --help      # show modes
#
# sync.sh and list.sh remain available as low-level building blocks. This
# script is the documented primary going forward.

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Styling helpers (subset of sync.sh's; intentionally not sourced to keep
# this script standalone and parseable in CI / non-interactive contexts).

_h() {
  if command -v gum &>/dev/null; then
    gum style --bold --foreground 212 "$1"
  else
    printf "\n\033[1;35m%s\033[0m\n" "$1"
  fi
}

_dim() {
  if command -v gum &>/dev/null; then
    gum style --foreground 245 "$1"
  else
    printf "\033[2m%s\033[0m\n" "$1"
  fi
}

_err() {
  printf "\033[1;31m  ✗ %s\033[0m\n" "$1"
}

# Returns 0 if `gum` is available — for interactive flows.
_has_gum() { command -v gum &>/dev/null; }

# ── Help

show_help() {
  cat <<EOF

  $(_h "notion-sync — pipeline launcher")

  Usage: bash run.sh [mode]

  Modes (run as: bash run.sh <mode>):

    push          Sync local docs to Notion (= bash sync.sh)
    push:full     Push + fetch cache + diff + recent-errors + sitemap
    fix           Run fix-mentions + recent-errors over current cache
    check         Read-only verification: fetch + diff + recent-errors
    dashboard     Refresh sitemap + tag-index (and any other dashboards)
    bring-up      Full first-time bring-up: push, fetch, sitemap, tag-index

  Other:

    -h, --help    Show this help
    (no args)     Interactive mode picker (gum-styled if available)

  Lower-level scripts remain available:

    bash sync.sh [...]    Direct sync (wizard / flags)
    bash list.sh [cmd]    Cache fetch / diff / fix-mentions / sitemap / etc.

  See ROADMAP.md for what's planned, USAGE.md for full task recipes.
EOF
}

# ── Phase implementations
#
# Each phase prints a heading + runs one underlying command. Phase failures
# bubble up via `set -e`; each mode catches and reports them with a final
# summary.

phase_push() {
  _h "▶ Push (sync.sh)"
  bash sync.sh "$@"
}

phase_fetch() {
  _h "▶ Fetch remote cache (list.sh fetch)"
  bash list.sh fetch
}

phase_diff() {
  _h "▶ Diff local vs remote (list.sh diff)"
  bash list.sh diff || true # diff exits non-zero on drift; not a failure
}

phase_recent_errors() {
  _h "▶ Recent errors (list.sh recent-errors)"
  bash list.sh recent-errors --limit 5
}

phase_fix_mentions() {
  _h "▶ Fix mentions (list.sh fix-mentions)"
  bash list.sh fix-mentions
}

phase_sitemap() {
  _h "▶ Sitemap (list.sh sitemap)"
  bash list.sh sitemap
}

phase_tag_index() {
  _h "▶ Tag index (list.sh tag-index)"
  bash list.sh tag-index
}

phase_backlinks() {
  _h "▶ Backlinks (list.sh backlinks)"
  bash list.sh backlinks
}

phase_recent_feed() {
  _h "▶ Recent feed (list.sh recent-feed)"
  bash list.sh recent-feed
}

# ── Mode dispatchers
#
# Each mode is a fixed sequence. Modes don't take arguments themselves —
# pass-through to phase_push only happens for the bare `push` mode.

mode_push() {
  shift # remove the "push" arg, pass the rest to sync.sh
  phase_push "$@"
}

mode_push_full() {
  phase_push
  phase_fetch
  phase_diff
  phase_recent_errors
  phase_sitemap
  echo ""
  _h "✓ push:full complete"
}

mode_fix() {
  phase_fix_mentions
  phase_recent_errors
  echo ""
  _h "✓ fix complete"
}

mode_check() {
  phase_fetch
  phase_diff
  phase_recent_errors
  echo ""
  _h "✓ check complete"
}

mode_dashboard() {
  phase_sitemap
  phase_tag_index
  phase_backlinks
  phase_recent_feed
  echo ""
  _h "✓ dashboard complete"
}

mode_bring_up() {
  phase_push
  phase_fetch
  phase_fix_mentions
  phase_sitemap
  phase_tag_index
  phase_recent_errors
  echo ""
  _h "✓ bring-up complete"
}

# ── Interactive picker (gum) or fallback prompt

interactive_pick() {
  local choice
  if _has_gum; then
    choice=$(gum choose --header "Pick a mode (Ctrl+C to cancel):" \
      "push          — sync local docs to Notion" \
      "push:full     — push + fetch + diff + recent-errors + sitemap" \
      "fix           — fix-mentions + recent-errors" \
      "check         — read-only: fetch + diff + recent-errors" \
      "dashboard     — refresh sitemap + tag-index" \
      "bring-up      — full first-time sequence" \
      "help          — show all modes")
  else
    echo ""
    echo "  Pick a mode:"
    echo "    1) push           sync local docs to Notion"
    echo "    2) push:full      push + fetch + diff + recent-errors + sitemap"
    echo "    3) fix            fix-mentions + recent-errors"
    echo "    4) check          read-only: fetch + diff + recent-errors"
    echo "    5) dashboard      refresh sitemap + tag-index"
    echo "    6) bring-up       full first-time sequence"
    echo "    7) help"
    read -r -p "  > " idx
    case "$idx" in
      1) choice="push" ;;
      2) choice="push:full" ;;
      3) choice="fix" ;;
      4) choice="check" ;;
      5) choice="dashboard" ;;
      6) choice="bring-up" ;;
      7) choice="help" ;;
      *) _err "invalid selection"; exit 1 ;;
    esac
  fi
  # Strip trailing description from gum output ("push          — ...")
  echo "${choice%% *}"
}

# ── Main

MODE="${1:-}"

case "$MODE" in
  -h|--help|help)
    show_help
    ;;
  "")
    selected=$(interactive_pick)
    if [ "$selected" = "help" ]; then show_help; exit 0; fi
    exec bash "$0" "$selected"
    ;;
  push)
    mode_push "$@"
    ;;
  push:full|push-full|pushfull)
    mode_push_full
    ;;
  fix)
    mode_fix
    ;;
  check)
    mode_check
    ;;
  dashboard|dashboards)
    mode_dashboard
    ;;
  bring-up|bringup|bring_up)
    mode_bring_up
    ;;
  *)
    _err "unknown mode: $MODE"
    _dim "  bash run.sh --help for available modes"
    exit 1
    ;;
esac
