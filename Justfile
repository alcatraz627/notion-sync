# notion-sync — Justfile (mirror of run.sh modes for `just` users)
#
# Install just: brew install just  ·  cargo install just
# Run a recipe: just <name>
# List all:     just --list
#
# Each recipe shells out to bash run.sh / sync.sh / list.sh — the bash
# scripts remain the source of truth, this is just a discoverability /
# tab-completion layer for users who already have `just` installed.

# Default: show available recipes
default:
    @just --list

# ── Pipelines (mirror of bash run.sh modes)

# Sync local docs to Notion
push *ARGS:
    bash sync.sh {{ARGS}}

# push + fetch + diff + recent-errors + sitemap
push-full:
    bash run.sh push:full

# fix-mentions + recent-errors
fix:
    bash run.sh fix

# read-only verification: fetch + diff + recent-errors
check:
    bash run.sh check

# refresh sitemap + tag-index
dashboard:
    bash run.sh dashboard

# full first-time bring-up sequence
bring-up:
    bash run.sh bring-up

# ── Direct phases (low-level)

# Refresh remote cache
fetch:
    bash list.sh fetch

# Title-based diff vs local docs
diff:
    bash list.sh diff

# Surface failed paths from recent runs
errors *ARGS:
    bash list.sh recent-errors {{ARGS}}

# Convert internal links → mention pills page-wide
fix-mentions:
    bash list.sh fix-mentions

# Push the 🗺️ Sitemap dashboard page
sitemap:
    bash list.sh sitemap

# Push the 🏷️ Tags dashboard page
tag-index:
    bash list.sh tag-index

# Push/refresh the 📇 Doc Index sidecar database
index-db:
    bash list.sh index-db

# ── Maintenance

# Type-check the TypeScript modules
typecheck:
    bunx tsc --noEmit --skipLibCheck --target es2020 --module esnext --moduleResolution bundler index.ts notion-list.ts sitemap.ts tag-index.ts index-db.ts mention-converter.ts

# Tail the most recent runs.jsonl entry
last-run:
    @tail -n 1 runs.jsonl | python3 -m json.tool

# Show currently-running processes related to notion-sync
ps:
    @ps aux | grep -E "(bun.*notion|bash.*sync|bash.*list)" | grep -v grep || echo "(none running)"
