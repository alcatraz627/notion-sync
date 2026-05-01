# Suspicion rules reference

When a Notion API call fails with a server-side rejection (5xx, validation error), notion-sync runs the file's content through a list of pattern checks and surfaces likely causes in the run log. This file documents each rule with concrete code samples — what triggers it, what doesn't, and how to fix.

The rules live in `index.ts` (`SUSPICION_RULES` array, lines 332–377). Findings appear in:

- terminal output (one line per fired rule, prefixed `?`)
- `runs.jsonl` → `error_summary[i].suspicions[]`
- `runs.jsonl` → `pages[i].suspicions[]`

Each rule has a `name`, `explain` string, and a `check(content) → boolean` predicate.

> **Note on scope**: rules apply to the **rewritten markdown body** sent to Notion, after frontmatter stripping, link rewriting, and image rewriting. So an HTML comment with `<script>` in your source is never a problem (the comment-stripper removes it first), but a `<script>` tag in a code fence still trips the rule.

---

## `cloudflare-waf-curl`

**Trigger**: literal `curl` followed by `localhost`, `127.0.0.1`, or any `<digit>.<digit>.<digit>.<digit>` IP — anywhere in the body, including fenced code blocks.

**Why it fails**: Cloudflare's WAF flags `curl` + localhost/IP combinations in POST bodies as SSRF (Server-Side Request Forgery) attempts. The Notion API sits behind Cloudflare, so the request gets blocked before reaching Notion's servers.

```typescript
check: (c) => /curl\s+.*localhost/i.test(c)
            || /curl\s+.*\d+\.\d+\.\d+\.\d+/i.test(c)
```

### Examples

❌ **Triggers (will fail)**:

````markdown
Test the local backend:

```bash
curl http://localhost:3000/api/health
```
````

````markdown
Connect to the staging IP directly:

```bash
curl https://10.0.0.42/healthz | jq
```
````

✅ **Safe**:

````markdown
Test the local backend:

- Run `npm run start:dev` to bring up the local server.
- Visit `http://localhost:3000/api/health` in a browser, or use HTTPie / Insomnia.

(Same instructions, no `curl + IP` token sequence.)
````

````markdown
On the staging cluster the health endpoint is at `https://api.staging/healthz`.
Use a hostname, not an IP, to avoid SSRF flags from the proxy.
````

### Fix

- Replace `curl ... localhost` with hostname-based examples (`api.local.test`, `internal-svc.your-domain.dev`).
- Or describe the request in prose without the literal `curl` token.
- Or move the example to an external snippets file and link to it.

---

## `cloudflare-waf-shell-pipe`

**Trigger**: a backtick-delimited inline code span containing a shell pipe (e.g. `` `cmd | head` ``) **outside** a fenced code block.

```typescript
check: (c) => {
  const stripped = c.replace(/```[\s\S]*?```/g, "");
  return /`[^`]*\|\s*\w+[^`]*`/.test(stripped);
}
```

**Why it fails**: command-injection WAF signatures match shell pipe patterns. Inside a fenced code block these are mostly fine because Cloudflare expects pre-formatted code there; in inline-code spans (especially in table cells, list items, or running prose), the same pattern looks like a shell-injection attempt.

### Examples

❌ **Triggers**:

```markdown
Use `tail -f run.log | grep ERROR` to watch for failures.
```

```markdown
| Command                       | Purpose       |
|-------------------------------|---------------|
| `ps aux | grep bun`           | find sync     |
| `cat runs.jsonl | jq .stats`  | latest stats  |
```

✅ **Safe**:

````markdown
Use this to watch for failures:

```bash
tail -f run.log | grep ERROR
```
````

```markdown
| Command            | Purpose                           |
|--------------------|-----------------------------------|
| `ps aux`           | find the sync process             |
| `cat runs.jsonl`   | read the run log; filter with jq  |
```

### Fix

- Move the piped command into a fenced ``` ```bash ``` block.
- Or split the pipe across separate inline spans / cells.
- Or rephrase: "tail the log, then grep for ERROR" without the literal pipe token.

---

## `cloudflare-waf-sql-keyword`

**Trigger**: any of `SELECT`, `DROP`, `INSERT`, `UPDATE`, `DELETE`, `CREATE TABLE`, `ALTER TABLE` (case-insensitive, word-boundary) **outside** a fenced code block.

```typescript
check: (c) => {
  const stripped = c.replace(/```[\s\S]*?```/g, "");
  return /\b(SELECT|DROP|INSERT|UPDATE|DELETE|CREATE TABLE|ALTER TABLE)\b/i.test(stripped);
}
```

**Why it fails**: ModSecurity (the OWASP CRS rule pack Cloudflare uses by default) treats SQL keywords in POST bodies as potential SQL injection. Inside fenced blocks → expected as code. In prose or tables → looks like an attacker leaking SQL into a request.

### Examples

❌ **Triggers**:

```markdown
The migration ALTER TABLE invoices ADD COLUMN currency runs at 02:00 UTC.
```

```markdown
| When to use      | What it does                           |
|------------------|----------------------------------------|
| `SELECT * FROM…` | full-table scan; avoid in production   |
```

✅ **Safe**:

````markdown
The migration adds the `currency` column to `invoices`, runs at 02:00 UTC:

```sql
ALTER TABLE invoices ADD COLUMN currency text;
```
````

```markdown
| When to use         | What it does                            |
|---------------------|-----------------------------------------|
| Full-table scan     | reads every row; avoid in production    |
| Index seek          | constant-time; preferred for hot paths  |
```

### Fix

- Wrap any SQL keyword in a fenced ``` ```sql ``` block.
- In tables, replace SQL keyword cells with prose descriptions.
- For inline mentions of "SELECT" as a UI control name (not SQL), capitalize differently or use double-quotes (`"Select"` button).

---

## `cloudflare-waf-script-tag`

**Trigger**: literal `<script ` or `<script>` anywhere in the body.

```typescript
check: (c) => /<script[\s>]/i.test(c)
```

**Why it fails**: `<script>` is the canonical XSS attack vector — Cloudflare blocks it unconditionally in POST bodies, no matter the surrounding context. There's no whitelist for "documentation about script tags."

### Examples

❌ **Triggers** (all of these fail):

````markdown
For dev-only diagnostics, drop this into the page:

```html
<script>console.log('debug');</script>
```
````

```markdown
Reference XSS payloads for the security audit: `<script>alert(1)</script>`, `<svg onload=alert(1)>`, etc.
```

✅ **Safe**:

````markdown
For dev-only diagnostics, drop this into the page:

```text
[script tag] console.log('debug') [/script tag]
```

(Pseudo-syntax — replace with a real tag in your editor.)
````

```markdown
Reference XSS payloads for the security audit: see `assets/xss-samples.md` (synced separately or stored outside the docs tree).
```

### Fix

- Escape angle brackets: write `&lt;script&gt;`, or use Unicode lookalikes (`⟨script⟩`).
- Or move XSS examples into an off-tree file and link to it.
- Or split: `<` and `script>` on separate lines so the regex doesn't match.

> **No way to whitelist legitimate documentation use** — this is hardcoded in Cloudflare's WAF. Treat it as an absolute prohibition for any text that hits the Notion API.

---

## `notion-body-too-large`

**Trigger**: rewritten markdown body exceeds 500 KB (UTF-8 byte length).

```typescript
check: (c) => Buffer.byteLength(c, "utf8") > 500_000
```

**Why it fails**: Notion's markdown endpoint has an undocumented body size limit somewhere around 1–2 MB. Files approaching that get rejected with a generic 400 or time out under load. The 500 KB threshold is a conservative warning — real failures often happen between 800 KB and 2 MB.

### Examples

❌ **Triggers (>500 KB after rewrites)**:

- A doc with **hundreds of inline images** as base64 data URLs (each ~100 KB → 5 images = 500 KB)
- A doc that **embeds a large JSON schema** verbatim (e.g. a copy-pasted OpenAPI spec, 800 KB+)
- A doc that includes a **full `git diff`** of a major refactor as a fenced code block

✅ **Safe**:

- Same content split across multiple `_index.md` + sibling docs (each <500 KB)
- Large JSON moved to a separate file; link from the main doc
- `git diff` excerpted to relevant hunks; full diff linked via GitHub commit URL

### Fix

- Split the doc — one logical concept per file, link them together.
- Move large code samples / data dumps to sibling files or external URLs.
- For unavoidable large docs, accept the warning and watch for the actual API failure (it doesn't always trigger at 500 KB).

---

## Disabling rules

The rules are hardcoded in `SUSPICION_RULES` (`index.ts:332`). To disable:

```typescript
// Comment out the rule object, OR replace `check` with `() => false`
{
  name: "cloudflare-waf-sql-keyword",
  explain: "…",
  check: () => false,   // ← disabled
}
```

There's no env-var toggle yet — this is intentionally a code-level decision (the rules represent real failure modes; disabling them means accepting silent confusion when a sync fails).

## Adding new rules

Follow the existing shape:

```typescript
{
  name: "your-rule-name",            // dash-case, used in error_summary
  explain: "Human-readable cause",   // shown in terminal + run log
  check: (content: string) => boolean,
}
```

The `content` arg is the rewritten markdown body — frontmatter already stripped, links rewritten, images rewritten, HTML comments removed. So your regex can assume "this is what Notion will see."

Strip fenced code blocks first if your rule should only apply to prose/tables/inline:

```typescript
const stripped = c.replace(/```[\s\S]*?```/g, "");
return /your-pattern/.test(stripped);
```

After adding, append a section to this file with the rule name, code, examples, and fix guidance. Update the table in `CLAUDE.md` ("Suspicion rules") with a one-line summary.
