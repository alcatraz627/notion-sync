// Read-only probe: walk a page's blocks and surface every rich_text link URL,
// flagging ones Notion would reject on blocks.update ("Invalid URL for link").
// Usage: bun scripts/probe-bad-link.ts <pageId>
import { Client } from "@notionhq/client";
import { loadEnv } from "../lib/env";

loadEnv(".env");
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const pageId = process.argv[2];
if (!pageId) { console.error("usage: bun scripts/probe-bad-link.ts <pageId>"); process.exit(1); }

const RT_TYPES = ["paragraph","heading_1","heading_2","heading_3","bulleted_list_item","numbered_list_item","to_do","toggle","quote","callout","code","template"];

// A URL Notion accepts: absolute http(s)/mailto, or a "/..." path? Empirically
// Notion's link validation rejects relative/scheme-less URLs and anything with
// whitespace. We flag anything that isn't http(s)://, mailto:, or notion-internal.
function suspicious(url: string): string | null {
  if (/\s/.test(url)) return "contains-whitespace";
  if (/^https?:\/\//i.test(url)) return null;
  if (/^mailto:/i.test(url)) return null;
  if (url === "") return "empty";
  return "no-scheme/relative";
}

let inspected = 0, links = 0, bad = 0;
async function visit(id: string) {
  let cursor: string | undefined;
  do {
    const res: any = await notion.blocks.children.list({ block_id: id, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    await new Promise((r) => setTimeout(r, 350));
    for (const b of res.results as any[]) {
      inspected++;
      const t = b.type;
      const collect = (rt: any[]) => {
        for (const item of rt ?? []) {
          const url = item?.text?.link?.url;
          if (typeof url === "string") {
            links++;
            const why = suspicious(url);
            if (why) { bad++; console.log(`  [${why}] block ${b.id.slice(0,8)} (${t}): ${JSON.stringify(url)}  text=${JSON.stringify(item?.text?.content?.slice(0,40))}`); }
          }
        }
      };
      if (RT_TYPES.includes(t)) collect(b[t]?.rich_text);
      if (t === "table_row") for (const cell of (b.table_row?.cells ?? [])) collect(cell);
      if (b.has_children) await visit(b.id);
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
}

await visit(pageId);
console.log(`\nDONE  blocks=${inspected}  links=${links}  suspicious=${bad}`);
