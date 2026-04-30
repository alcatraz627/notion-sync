// image-uploader.ts — content-addressed image upload to Notion's CDN.
//
// Why: private GitHub repos return 404 to Notion when it tries to fetch
// raw.githubusercontent.com URLs. Solution: upload each image to Notion via
// the v5 fileUploads API and reference by file_upload_id in image blocks.
//
// Dedup: cache keyed by sha256(file bytes) → file_upload_id. Same content
// across renames/moves reuses the upload. Edited images get a new upload;
// the old one becomes orphaned (cleanup via fileUploads.list later).
//
// Upload protocol (single_part mode, sufficient for any file < 20MB):
//   1. fileUploads.create({ mode: "single_part", filename, content_type })
//   2. fileUploads.send({ file_upload_id, file: { filename, data: Blob } })
//   No complete step — single_part finalizes on send.

import { Client } from "@notionhq/client";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

interface ImageCacheEntry {
  file_upload_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  uploaded_at: string;
}

interface ImageCache {
  [sha256: string]: ImageCacheEntry;
}

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

export interface UploadResult {
  file_upload_id: string;
  was_cached: boolean;
  sha256: string;
  size_bytes: number;
}

export class ImageUploader {
  private cache: ImageCache = {};
  private cachePath: string;
  private notion: Client;
  private rateLimitMs: number;
  private uploadCount = 0;
  private cacheHitCount = 0;

  constructor(notion: Client, cachePath: string, rateLimitMs = 350) {
    this.notion = notion;
    this.cachePath = cachePath;
    this.rateLimitMs = rateLimitMs;
    this.loadCache();
  }

  private loadCache(): void {
    if (!fs.existsSync(this.cachePath)) return;
    try {
      this.cache = JSON.parse(fs.readFileSync(this.cachePath, "utf8"));
    } catch {
      this.cache = {};
    }
  }

  private saveCache(): void {
    fs.writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private hashFile(absPath: string): string {
    return crypto.createHash("sha256").update(fs.readFileSync(absPath)).digest("hex");
  }

  private contentTypeFor(filename: string): string {
    return CONTENT_TYPES[path.extname(filename).toLowerCase()] ?? "application/octet-stream";
  }

  /**
   * Upload an image file to Notion (or return cached file_upload_id).
   * Throws on upload failure — caller decides whether to abort or skip.
   */
  async uploadImage(absPath: string): Promise<UploadResult> {
    if (!fs.existsSync(absPath)) {
      throw new Error(`image not found: ${absPath}`);
    }
    const sha = this.hashFile(absPath);
    const size_bytes = fs.statSync(absPath).size;

    const cached = this.cache[sha];
    if (cached) {
      this.cacheHitCount++;
      return { file_upload_id: cached.file_upload_id, was_cached: true, sha256: sha, size_bytes };
    }

    const filename = path.basename(absPath);
    const content_type = this.contentTypeFor(filename);

    // Step 1: register the upload (returns file_upload_id + presigned upload_url)
    const created: any = await (this.notion as any).fileUploads.create({
      mode: "single_part",
      filename,
      content_type,
    });
    await this.sleep(this.rateLimitMs);

    // Step 2: send bytes via the SDK's multipart-form helper
    const fileBuffer = fs.readFileSync(absPath);
    const blob = new Blob([fileBuffer], { type: content_type });
    await (this.notion as any).fileUploads.send({
      file_upload_id: created.id,
      file: { filename, data: blob },
    });
    await this.sleep(this.rateLimitMs);

    this.cache[sha] = {
      file_upload_id: created.id,
      filename,
      content_type,
      size_bytes,
      uploaded_at: new Date().toISOString(),
    };
    this.saveCache();
    this.uploadCount++;

    return { file_upload_id: created.id, was_cached: false, sha256: sha, size_bytes };
  }

  getStats(): { uploads: number; cache_hits: number; total_in_cache: number } {
    return {
      uploads: this.uploadCount,
      cache_hits: this.cacheHitCount,
      total_in_cache: Object.keys(this.cache).length,
    };
  }
}

/**
 * After updateMarkdown creates image blocks (type=external pointing at the
 * github raw URLs we rewrote into the markdown), walk the page's blocks,
 * find images whose external.url matches an entry in urlToUploadId, and
 * blocks.update each to switch to type=file_upload.
 *
 * Recurses into block children (image blocks can live inside callouts or
 * toggles). Returns count of swapped blocks.
 */
export async function swapImageBlocks(
  notion: Client,
  pageId: string,
  urlToUploadId: Map<string, string>,
  rateLimitMs = 350,
): Promise<number> {
  if (urlToUploadId.size === 0) return 0;

  let swapped = 0;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  async function walk(blockId: string): Promise<void> {
    let cursor: string | undefined;
    do {
      const res: any = await notion.blocks.children.list({
        block_id: blockId,
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      await sleep(rateLimitMs);

      for (const block of res.results as any[]) {
        if (block.type === "image" && block.image?.type === "external") {
          const url = block.image.external?.url;
          const fileUploadId = url ? urlToUploadId.get(url) : undefined;
          if (fileUploadId) {
            // Notion's blocks.update infers the image type from which sub-field
            // is present — do NOT send `type` explicitly (validation rejects it).
            await (notion.blocks as any).update({
              block_id: block.id,
              image: {
                file_upload: { id: fileUploadId },
                caption: block.image.caption ?? [],
              },
            });
            await sleep(rateLimitMs);
            swapped++;
          }
        }
        // Recurse into children if present (callouts, toggles, columns can
        // contain image blocks). Skip child_page blocks — those are subpages.
        if (block.has_children && block.type !== "child_page") {
          await walk(block.id);
        }
      }
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
  }

  await walk(pageId);
  return swapped;
}
