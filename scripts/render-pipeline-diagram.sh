#!/bin/bash
source ~/.claude/skills/shared/gum-tui.sh

# === Title ===
gum style --bold --foreground 6 --padding '1 2' --border double --align center --width 76 \
  'notion-sync — End-to-End Pipeline' \
  'markdown → Notion (with rename-safety, mentions, dashboards, prune)'

echo

# === Top: Local sources ===
DOCS=$(gum style --border rounded --padding '0 2' --foreground 2 'docs/**/*.md')
ENV=$(gum style --border rounded --padding '0 2' --foreground 2 '.env')
SOURCES=$(gum join --horizontal "$DOCS" "   " "$ENV")
LOCAL_LAYER=$(gum style --border double --padding '0 2' --width 76 --foreground 4 \
  "$(gum style --bold --foreground 4 'LOCAL FILESYSTEM')" \
  "$SOURCES")
echo "$LOCAL_LAYER"

echo "                                  │"
echo "                                  ▼"

# === Caches (gitignored) ===
NCACHE=$(gum style --border rounded --padding '0 1' --foreground 3 '.notion-cache.json')
ICACHE=$(gum style --border rounded --padding '0 1' --foreground 3 '.notion-image-cache.json')
RUNS=$(gum style --border rounded --padding '0 1' --foreground 3 'runs.jsonl')
CACHE_ROW=$(gum join --horizontal "$NCACHE" "  " "$ICACHE" "  " "$RUNS")
CACHES=$(gum style --border double --padding '0 2' --width 76 --foreground 3 \
  "$(gum style --bold --foreground 3 'STATE / CACHES (gitignored)')" \
  "$CACHE_ROW")
echo "$CACHES"

echo "                                  │"
echo "                                  ▼"

# === Phase 1 ===
P1_GET=$(gum style --border rounded --padding '0 1' 'getOrCreateChildPage')
P1_IDX=$(gum style --border rounded --padding '0 1' 'globalTitleIndex')
P1_MOVE=$(gum style --border normal --padding '0 1' --foreground 5 'pages.update(parent)')
P1_ROW=$(gum join --horizontal "$P1_GET" "  " "$P1_IDX" "  " "$P1_MOVE")
PHASE1=$(gum style --border double --padding '0 2' --width 76 --foreground 6 \
  "$(gum style --bold --foreground 6 'PHASE 1 — Discovery (build pageIdMap; rename-safety MOVE detection)')" \
  "$P1_ROW")
echo "$PHASE1"

echo "                                  │"
echo "                                  ▼"

# === Phase 1.5 ===
P15_LIST=$(gum style --border rounded --padding '0 1' 'list-blocks')
P15_DEL=$(gum style --border rounded --padding '0 1' 'delete-prose')
P15_INS=$(gum style --border rounded --padding '0 1' 'insert_content')
P15_ROW=$(gum join --horizontal "$P15_LIST" " ──▶ " "$P15_DEL" " ──▶ " "$P15_INS")
PHASE15=$(gum style --border double --padding '0 2' --width 76 --foreground 6 \
  "$(gum style --bold --foreground 6 'PHASE 1.5 — Section content (preserves child_page subpages)')" \
  "$P15_ROW")
echo "$PHASE15"

echo "                                  │"
echo "                                  ▼"

# === Phase 2 ===
P2_IMG=$(gum style --border rounded --padding '0 1' 'image-uploader')
P2_MD=$(gum style --border rounded --padding '0 1' 'updateMarkdown')
P2_MEN=$(gum style --border rounded --padding '0 1' 'mention-converter')
P2_ROW=$(gum join --horizontal "$P2_IMG" " ──▶ " "$P2_MD" " ──▶ " "$P2_MEN")
PHASE2=$(gum style --border double --padding '0 2' --width 76 --foreground 6 \
  "$(gum style --bold --foreground 6 'PHASE 2 — Leaf content (images + content + native mentions)')" \
  "$P2_ROW")
echo "$PHASE2"

echo "                                  │"
echo "                                  ▼"

# === Notion API layer ===
NPAGES=$(gum style --border rounded --padding '0 1' 'pages')
NBLOCKS=$(gum style --border rounded --padding '0 1' 'blocks')
NDB=$(gum style --border rounded --padding '0 1' 'databases / dataSources')
NUP=$(gum style --border rounded --padding '0 1' 'fileUploads (CDN)')
N_ROW1=$(gum join --horizontal "$NPAGES" "  " "$NBLOCKS" "  " "$NDB")
N_ROW2=$(gum style --align center --width 72 "$NUP")
NOTION=$(gum style --border double --padding '0 2' --width 76 --foreground 1 \
  "$(gum style --bold --foreground 1 'NOTION API (@notionhq/client v5  ·  adaptive 350-1050ms backoff)')" \
  "$N_ROW1" \
  "$N_ROW2")
echo "$NOTION"

echo
gum style --bold --foreground 5 --align center --width 76 \
  '─────────────────────  POST-SYNC PIPELINE  ─────────────────────'
echo

# === Dashboards ===
D1=$(gum style --border rounded --padding '0 1' --foreground 4 '🗺️  sitemap')
D2=$(gum style --border rounded --padding '0 1' --foreground 4 '🏷️  tag-index')
D4=$(gum style --border rounded --padding '0 1' --foreground 4 '📇 index-db')
D5=$(gum style --border rounded --padding '0 1' --foreground 4 '📣 recent-feed')
D7=$(gum style --border rounded --padding '0 1' --foreground 4 '🔗 backlinks')
D6=$(gum style --border rounded --padding '0 1' --foreground 4 '🩺 health')
D_ROW1=$(gum join --horizontal "$D1" "  " "$D2" "  " "$D4")
D_ROW2=$(gum join --horizontal "$D5" "  " "$D7" "  " "$D6")
DASHBOARDS=$(gum style --border double --padding '0 2' --width 76 --foreground 4 \
  "$(gum style --bold --foreground 4 'DASHBOARDS — bash run.sh dashboard  (read cache + runs.jsonl)')" \
  "$D_ROW1" \
  "$D_ROW2")
echo "$DASHBOARDS"

echo
echo "                                  │"
echo "                                  ▼"

# === Prune ===
PRUNE_PAGES=$(gum style --border rounded --padding '0 1' --foreground 1 'prune (orphan pages)')
PRUNE_IMG=$(gum style --border rounded --padding '0 1' --foreground 1 'prune-images (planned)')
PRUNE_ROW=$(gum join --horizontal "$PRUNE_PAGES" "  " "$PRUNE_IMG")
PRUNE=$(gum style --border double --padding '0 2' --width 76 --foreground 1 \
  "$(gum style --bold --foreground 1 'PRUNE — dry-run by default; --apply requires explicit confirm')" \
  "$PRUNE_ROW")
echo "$PRUNE"

echo
gum style --italic --foreground 8 --align center --width 76 \
  'Cache feeds Phase 1 (move detection) AND dashboards (sitemap, tag-index, recent-feed, backlinks).' \
  'runs.jsonl feeds recent-feed + health.   .notion-image-cache.json feeds prune-images.'
