import { google, type drive_v3 } from "googleapis";
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { Logger } from "./logger";
import type { IgnoreMatcher } from "./ignore";

const EXPORT_MAP: Record<string, { mime: string; ext: string }> = {
  "application/vnd.google-apps.document":     { mime: "text/markdown", ext: ".md" },
  "application/vnd.google-apps.spreadsheet":  { mime: "text/csv", ext: ".csv" },
  "application/vnd.google-apps.presentation": { mime: "application/pdf", ext: ".pdf" },
  "application/vnd.google-apps.drawing":      { mime: "image/png", ext: ".png" },
};

const SKIP_MIMES = new Set([
  "application/vnd.google-apps.form", "application/vnd.google-apps.map",
  "application/vnd.google-apps.site", "application/vnd.google-apps.script",
]);

const FOLDER = "application/vnd.google-apps.folder";
const SHORTCUT = "application/vnd.google-apps.shortcut";
const FOLDER_ID_RE = /^[a-zA-Z0-9_-]+$/;

export interface DriveFile {
  id: string; name: string; size: number; relativePath: string;
  exportMime?: string; exportExt?: string;
}

// Auth

export async function createDriveClient(keyPath: string): Promise<drive_v3.Drive> {
  const key = await Bun.file(keyPath).json();
  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: key.client_email, private_key: key.private_key },
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  return google.drive({ version: "v3", auth });
}

// Retry wrapper for transient Google API errors

async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (err: any) {
      const status = err?.response?.status ?? err?.code;
      if (attempt >= retries || ![429, 500, 503].includes(status)) throw err;
      await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** attempt, 16000) + Math.random() * 1000));
    }
  }
}

// Sanitize filenames (Google Drive allows /, \, and other OS-illegal chars)

function sanitize(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "_");
}

// Listing

export async function listFiles(
  drive: drive_v3.Drive, folderId: string, logger: Logger,
  ignore: IgnoreMatcher, basePath = "", visited = new Set<string>(),
): Promise<DriveFile[]> {
  if (visited.has(folderId)) { logger.warn(`Circular reference: ${basePath}`); return []; }
  visited.add(folderId);

  const files: DriveFile[] = [];
  const subfolders: { id: string; path: string }[] = [];
  let pageToken: string | undefined;

  do {
    const res = await withRetry(() => drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, size, shortcutDetails)",
      pageSize: 1000, pageToken,
      includeItemsFromAllDrives: true, supportsAllDrives: true,
    }));
    pageToken = res.data.nextPageToken ?? undefined;

    for (const item of res.data.files ?? []) {
      const rawName = item.name ?? "untitled";
      const name = sanitize(rawName);
      const mime = item.mimeType ?? "application/octet-stream";
      const id = item.id ?? "";
      const path = basePath ? `${basePath}/${name}` : name;

      // Resolve shortcuts
      if (mime === SHORTCUT) {
        const tid = item.shortcutDetails?.targetId;
        const tmime = item.shortcutDetails?.targetMimeType;
        if (!tid || !tmime) { logger.warn(`Unresolvable shortcut: ${rawName}`); continue; }
        if (tmime === FOLDER) {
          if (!ignore.isIgnored(path, true)) subfolders.push({ id: tid, path });
        } else {
          addFile(files, tid, name, tmime, item.size, path, logger, ignore);
        }
        continue;
      }

      if (mime === FOLDER) {
        if (!ignore.isIgnored(path, true)) { logger.debug(`Entering: ${path}`); subfolders.push({ id, path }); }
        continue;
      }

      addFile(files, id, name, mime, item.size, path, logger, ignore);
    }
  } while (pageToken);

  // Parallel subfolder traversal (bounded)
  const BATCH = 6;
  for (let i = 0; i < subfolders.length; i += BATCH) {
    const results = await Promise.all(
      subfolders.slice(i, i + BATCH).map(f => listFiles(drive, f.id, logger, ignore, f.path, visited))
    );
    for (const r of results) for (const f of r) files.push(f);
  }

  return files;
}

function addFile(
  files: DriveFile[], id: string, name: string, mime: string,
  rawSize: string | null | undefined, path: string, logger: Logger, ignore: IgnoreMatcher,
): void {
  if (SKIP_MIMES.has(mime)) { logger.debug(`Skip unsupported: ${name}`); return; }
  const exp = EXPORT_MAP[mime];
  const finalName = exp && !name.endsWith(exp.ext) ? name + exp.ext : name;
  const finalPath = path.slice(0, -name.length) + finalName;
  if (ignore.isIgnored(finalPath, false)) { logger.debug(`Ignored: ${finalPath}`); return; }
  files.push({ id, name: finalName, size: Number(rawSize) || 0, relativePath: finalPath, exportMime: exp?.mime, exportExt: exp?.ext });
}

// Downloading

async function downloadOne(drive: drive_v3.Drive, file: DriveFile, outDir: string, logger: Logger): Promise<number> {
  const dest = join(outDir, file.relativePath);
  const tmp = dest + ".tmp";

  // Skip if already exists with matching size
  if (!file.exportMime && file.size > 0) {
    try { if ((await stat(dest)).size === file.size) { logger.debug(`Exists: ${file.relativePath}`); return 0; } }
    catch { /* not found */ }
  }

  try {
    const res = await withRetry(() =>
      file.exportMime
        ? drive.files.export({ fileId: file.id, mimeType: file.exportMime }, { responseType: "stream" })
        : drive.files.get({ fileId: file.id, alt: "media" }, { responseType: "stream" })
    );
    const ws = createWriteStream(tmp);
    await pipeline(res.data as Readable, ws);
    await rename(tmp, dest);
    return ws.bytesWritten;
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function downloadAll(
  drive: drive_v3.Drive, files: DriveFile[], outDir: string, concurrency: number, logger: Logger,
): Promise<{ downloaded: number; skipped: number; totalBytes: number; errors: string[] }> {
  // Pre-create all directories at once
  const dirs = new Set(files.map(f => dirname(join(outDir, f.relativePath))));
  await Promise.all([...dirs].map(d => mkdir(d, { recursive: true })));

  let downloaded = 0, skipped = 0, totalBytes = 0, completed = 0;
  const errors: string[] = [];
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < files.length) {
      const file = files[idx++];
      try {
        const bytes = await downloadOne(drive, file, outDir, logger);
        if (bytes > 0) { downloaded++; totalBytes += bytes; } else { skipped++; }
      } catch (err: any) {
        const msg = `${file.relativePath}: ${err.message ?? err}`;
        logger.error(msg); errors.push(msg);
      }
      logger.progress(++completed, files.length, file.name, file.size);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  return { downloaded, skipped, totalBytes, errors };
}

// URL / ID extraction

export function extractFolderId(input: string): string {
  const m = input.match(/drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?folders|open\?id=)\/?([\w-]+)/);
  const id = m ? m[1] : input.trim();
  if (!FOLDER_ID_RE.test(id)) throw new Error(`Invalid folder ID: ${id}`);
  return id;
}
