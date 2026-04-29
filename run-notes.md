# Run Notes — notion-sync

Append-only log of notable findings from real sync runs. Each entry documents a pattern, fix, or observation that helps diagnose future runs. Kept here so Claude can read it alongside `runs.jsonl` for context.

---

## How to use

Ask Claude: "Check the latest run in runs.jsonl and add any findings to run-notes.md."

Claude should:
1. `tail -n 1 runs.jsonl | python3 -m json.tool` to read the latest run
2. Check `stats.errors`, `error_summary`, and `sections` for failures
3. Cross-reference `suspicions` fields for WAF / size / content issues
4. Append a dated entry below if anything notable was found

---

<!-- entries below, newest first -->
