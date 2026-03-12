/**
 * Google Drive API client for listing and downloading files.
 *
 * Uses a service account (JWT) for authentication.
 * Handles recursive folder traversal, binary downloads, and Google Workspace exports.
 */

import { google, type drive_v3 } from "googleapis";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Logger } from "./logger";
import type { IgnoreMatcher } from "./ignore";

// Google Workspace MIME types and their export targets
const EXPORT_MAP: Record<string, { mimeType: string; extension: string }> = {
  "application/vnd.google-apps.document": {
    mimeType: "text/markdown",
    extension: ".md",
  },
  "application/vnd.google-apps.spreadsheet": {
    mimeType: "text/csv",
    extension: ".csv",
  },
  "application/vnd.google-apps.presentation": {
    mimeType: "application/pdf",
    extension: ".pdf",
  },
  "application/vnd.google-apps.drawing": {
    mimeType: "image/png",
    extension: ".png",
  },
};

// MIME types that cannot be downloaded (no binary, no export)
const SKIP_MIME_TYPES = new Set([
  "application/vnd.google-apps.form",
  "application/vnd.google-apps.map",
  "application/vnd.google-apps.site",
  "application/vnd.google-apps.script",
]);

const FOLDER_MIME = "application/vnd.google-apps.folder";
const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  relativePath: string;
  isGoogleWorkspace: boolean;
  exportMimeType?: string;
  exportExtension?: string;
}

export interface DriveClientOptions {
  keyFilePath: string;
  logger: Logger;
  ignoreMatcher: IgnoreMatcher;
  concurrency: number;
  dryRun: boolean;
  outDir: string;
}

export async function createDriveClient(keyFilePath: string): Promise<drive_v3.Drive> {
  const keyFileContent = await Bun.file(keyFilePath).json();

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: keyFileContent.client_email,
      private_key: keyFileContent.private_key,
    },
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });

  return google.drive({ version: "v3", auth });
}

/**
 * Recursively list all files in a Google Drive folder.
 */
export async function listFilesRecursively(
  drive: drive_v3.Drive,
  folderId: string,
  logger: Logger,
  ignoreMatcher: IgnoreMatcher,
  basePath: string = ""
): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields:
        "nextPageToken, files(id, name, mimeType, size, shortcutDetails)",
      pageSize: 1000,
      pageToken,
    });

    const items = res.data.files ?? [];
    pageToken = res.data.nextPageToken ?? undefined;

    for (const item of items) {
      const name = item.name ?? "untitled";
      const mimeType = item.mimeType ?? "application/octet-stream";
      const id = item.id ?? "";
      const relativePath = basePath ? `${basePath}/${name}` : name;

      // Handle shortcuts: resolve to their target
      if (mimeType === SHORTCUT_MIME) {
        const targetId = item.shortcutDetails?.targetId;
        const targetMime = item.shortcutDetails?.targetMimeType;
        if (!targetId || !targetMime) {
          logger.warn(`Skipping unresolvable shortcut: ${name}`);
          continue;
        }

        if (targetMime === FOLDER_MIME) {
          if (ignoreMatcher.isIgnored(relativePath, true)) {
            logger.debug(`Ignored directory (shortcut): ${relativePath}`);
            continue;
          }
          const subFiles = await listFilesRecursively(
            drive,
            targetId,
            logger,
            ignoreMatcher,
            relativePath
          );
          files.push(...subFiles);
        } else {
          // Treat shortcut as the target file
          processFileEntry(files, targetId, name, targetMime, item.size, relativePath, logger, ignoreMatcher);
        }
        continue;
      }

      // Recurse into folders
      if (mimeType === FOLDER_MIME) {
        if (ignoreMatcher.isIgnored(relativePath, true)) {
          logger.debug(`Ignored directory: ${relativePath}`);
          continue;
        }
        logger.debug(`Entering folder: ${relativePath}`);
        const subFiles = await listFilesRecursively(
          drive,
          id,
          logger,
          ignoreMatcher,
          relativePath
        );
        files.push(...subFiles);
        continue;
      }

      processFileEntry(files, id, name, mimeType, item.size, relativePath, logger, ignoreMatcher);
    }
  } while (pageToken);

  return files;
}

function processFileEntry(
  files: DriveFile[],
  id: string,
  name: string,
  mimeType: string,
  rawSize: string | null | undefined,
  relativePath: string,
  logger: Logger,
  ignoreMatcher: IgnoreMatcher
): void {
  // Skip unsupported Google Workspace types
  if (SKIP_MIME_TYPES.has(mimeType)) {
    logger.debug(`Skipping unsupported type (${mimeType}): ${name}`);
    return;
  }

  const exportInfo = EXPORT_MAP[mimeType];
  const isGoogleWorkspace = !!exportInfo;
  let finalName = name;

  if (isGoogleWorkspace && exportInfo) {
    // Append export extension if the name does not already have it
    if (!name.endsWith(exportInfo.extension)) {
      finalName = name + exportInfo.extension;
    }
  }

  const finalRelativePath = relativePath.endsWith(name)
    ? relativePath.slice(0, -name.length) + finalName
    : relativePath;

  // Check ignore rules
  if (ignoreMatcher.isIgnored(finalRelativePath, false)) {
    logger.debug(`Ignored file: ${finalRelativePath}`);
    return;
  }

  files.push({
    id,
    name: finalName,
    mimeType,
    size: parseInt(rawSize ?? "0", 10) || 0,
    relativePath: finalRelativePath,
    isGoogleWorkspace,
    exportMimeType: exportInfo?.mimeType,
    exportExtension: exportInfo?.extension,
  });
}

/**
 * Download a single file from Google Drive.
 * Returns the number of bytes written.
 */
export async function downloadFile(
  drive: drive_v3.Drive,
  file: DriveFile,
  outDir: string,
  logger: Logger
): Promise<number> {
  const destPath = join(outDir, file.relativePath);

  // Ensure parent directory exists
  await mkdir(dirname(destPath), { recursive: true });

  // Skip if already exists with same size (for non-workspace files)
  if (!file.isGoogleWorkspace && file.size > 0) {
    try {
      const existing = await stat(destPath);
      if (existing.size === file.size) {
        logger.debug(`Skipping (already exists): ${file.relativePath}`);
        return 0;
      }
    } catch {
      // File doesn't exist, proceed with download
    }
  }

  if (file.isGoogleWorkspace && file.exportMimeType) {
    // Export Google Workspace files
    const res = await drive.files.export(
      { fileId: file.id, mimeType: file.exportMimeType },
      { responseType: "arraybuffer" }
    );
    const data = Buffer.from(res.data as ArrayBuffer);
    await writeFile(destPath, data);
    return data.length;
  } else {
    // Download binary files
    const res = await drive.files.get(
      { fileId: file.id, alt: "media" },
      { responseType: "arraybuffer" }
    );
    const data = Buffer.from(res.data as ArrayBuffer);
    await writeFile(destPath, data);
    return data.length;
  }
}

/**
 * Download multiple files with concurrency control.
 */
export async function downloadAll(
  drive: drive_v3.Drive,
  files: DriveFile[],
  outDir: string,
  concurrency: number,
  logger: Logger
): Promise<{ downloaded: number; skipped: number; totalBytes: number; errors: string[] }> {
  let downloaded = 0;
  let skipped = 0;
  let totalBytes = 0;
  const errors: string[] = [];
  let completed = 0;

  // Simple semaphore for concurrency
  let running = 0;
  const queue = [...files];

  async function processNext(): Promise<void> {
    while (queue.length > 0) {
      const file = queue.shift()!;
      try {
        const bytes = await downloadFile(drive, file, outDir, logger);
        if (bytes > 0) {
          downloaded++;
          totalBytes += bytes;
        } else {
          skipped++;
        }
      } catch (err: any) {
        const msg = `Failed to download ${file.relativePath}: ${err.message ?? err}`;
        logger.error(msg);
        errors.push(msg);
      }
      completed++;
      logger.progress(completed, files.length, file.name, file.size);
    }
  }

  // Launch concurrent workers
  const workers = Array.from({ length: Math.min(concurrency, files.length) }, () =>
    processNext()
  );
  await Promise.all(workers);

  return { downloaded, skipped, totalBytes, errors };
}

/**
 * Extract a folder ID from a Google Drive URL or return the input as-is.
 */
export function extractFolderId(input: string): string {
  // Match URLs like https://drive.google.com/drive/folders/XXXXX?...
  const urlMatch = input.match(
    /drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([a-zA-Z0-9_-]+)/
  );
  if (urlMatch) return urlMatch[1];

  // Match URLs like https://drive.google.com/open?id=XXXXX
  const openMatch = input.match(/drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/);
  if (openMatch) return openMatch[1];

  // Assume it's already a folder ID
  return input.trim();
}
