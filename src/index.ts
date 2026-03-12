#!/usr/bin/env bun

/**
 * drive-vacuum : recursively download all files from a Google Drive folder.
 *
 * Usage:
 *   drive-vacuum <folder-id-or-url> [options]
 *
 * Options:
 *   --out, -o       Output directory (default: ./drive-dump)
 *   --key, -k       Path to service account JSON key file
 *   --ignore, -i    Path to ignore file (default: .vacuumignore)
 *   --dry-run       List files without downloading
 *   --concurrency, -c  Max concurrent downloads (default: 5)
 *   --verbose, -v   Verbose logging
 *   --help, -h      Show help
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createLogger, formatBytes } from "./logger";
import { IgnoreMatcher } from "./ignore";
import {
  createDriveClient,
  listFilesRecursively,
  downloadAll,
  extractFolderId,
} from "./drive";

// ---- Arg parsing ----

interface CliArgs {
  folderInput: string | null;
  outDir: string;
  keyFile: string | null;
  ignoreFile: string;
  dryRun: boolean;
  concurrency: number;
  verbose: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  // Skip bun binary and script path
  const args = argv.slice(2);
  const result: CliArgs = {
    folderInput: null,
    outDir: "./drive-dump",
    keyFile: null,
    ignoreFile: ".vacuumignore",
    dryRun: false,
    concurrency: 5,
    verbose: false,
    help: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    switch (arg) {
      case "--help":
      case "-h":
        result.help = true;
        break;
      case "--verbose":
      case "-v":
        result.verbose = true;
        break;
      case "--dry-run":
        result.dryRun = true;
        break;
      case "--out":
      case "-o":
        result.outDir = args[++i] ?? result.outDir;
        break;
      case "--key":
      case "-k":
        result.keyFile = args[++i] ?? null;
        break;
      case "--ignore":
      case "-i":
        result.ignoreFile = args[++i] ?? result.ignoreFile;
        break;
      case "--concurrency":
      case "-c":
        result.concurrency = parseInt(args[++i] ?? "5", 10) || 5;
        break;
      default:
        // Positional argument: folder ID or URL
        if (!arg.startsWith("-") && result.folderInput === null) {
          result.folderInput = arg;
        } else if (arg.startsWith("-")) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
        break;
    }
    i++;
  }

  return result;
}

function showHelp(): void {
  console.log(`
     ____________
    [____________]
     |  ◉    ◉  |
     | DRIVE    |
     |   VACUUM |
     |___|  |___|
    /====|  |====\\
   |_____|__|_____|
      @        @

  Recursively download all files from a Google Drive folder.

  USAGE
    drive-vacuum <folder-id-or-url> [options]

  ARGUMENTS
    folder-id-or-url   Google Drive folder ID or full URL (required)

  OPTIONS
    --out, -o <dir>         Output directory (default: ./drive-dump)
    --key, -k <path>        Service account JSON key file
                            (default: env GOOGLE_SERVICE_ACCOUNT_KEY)
    --ignore, -i <path>     Ignore file path (default: .vacuumignore)
    --dry-run               List files without downloading
    --concurrency, -c <n>   Max concurrent downloads (default: 5)
    --verbose, -v           Show debug output
    --help, -h              Show this help

  IGNORE FILE (.vacuumignore)
    Supports gitignore-like patterns:
      *.pdf           Extension patterns
      node_modules/   Directory patterns
      temp_*          Glob wildcards
      !important.pdf  Negation (re-include)
      # comment       Comments

  GOOGLE WORKSPACE EXPORTS
    Google Docs    -> Markdown (.md)
    Google Sheets  -> CSV (.csv)
    Google Slides  -> PDF (.pdf)
    Google Drawing -> PNG (.png)

  EXAMPLES
    drive-vacuum 1A2B3C4D5E -o ./backup
    drive-vacuum https://drive.google.com/drive/folders/1A2B3C4D5E
    drive-vacuum 1A2B3C4D5E --key ./service-account.json --dry-run
`);
}

// ---- Main ----

async function main(): Promise<void> {
  const cli = parseArgs(process.argv);

  if (cli.help) {
    showHelp();
    process.exit(0);
  }

  const logger = createLogger(cli.verbose);
  logger.banner();

  // Validate folder ID
  if (!cli.folderInput) {
    logger.error("Missing required argument: folder ID or URL");
    logger.info("Run with --help for usage information.");
    process.exit(1);
  }

  const folderId = extractFolderId(cli.folderInput);
  logger.info(`Target folder ID: ${folderId}`);

  // Resolve key file
  const keyFile =
    cli.keyFile ?? process.env.GOOGLE_SERVICE_ACCOUNT_KEY ?? null;
  if (!keyFile) {
    logger.error(
      "No service account key provided. Use --key or set GOOGLE_SERVICE_ACCOUNT_KEY."
    );
    process.exit(1);
  }

  const keyPath = resolve(keyFile);
  if (!existsSync(keyPath)) {
    logger.error(`Service account key file not found: ${keyPath}`);
    process.exit(1);
  }

  // Load ignore patterns
  const ignoreMatcher = IgnoreMatcher.fromFile(resolve(cli.ignoreFile));
  logger.debug(`Ignore file: ${resolve(cli.ignoreFile)}`);

  // Output directory
  const outDir = resolve(cli.outDir);
  logger.info(`Output directory: ${outDir}`);

  if (cli.dryRun) {
    logger.info("DRY RUN: no files will be downloaded.");
  }

  // Connect to Google Drive
  logger.info("Authenticating with Google Drive...");
  const drive = await createDriveClient(keyPath);

  // List files recursively
  logger.info("Scanning folder structure...");
  const files = await listFilesRecursively(
    drive,
    folderId,
    logger,
    ignoreMatcher
  );

  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  logger.info(`Found ${files.length} files (${formatBytes(totalSize)} total)`);

  if (files.length === 0) {
    logger.warn("No files to download.");
    process.exit(0);
  }

  // Dry run: list files and exit
  if (cli.dryRun) {
    console.log("");
    for (const file of files) {
      const sizeStr = file.size > 0 ? formatBytes(file.size) : "(workspace)";
      const tag = file.isGoogleWorkspace ? ` [export: ${file.exportExtension}]` : "";
      console.log(`  ${file.relativePath}  ${sizeStr}${tag}`);
    }
    console.log("");
    logger.info(`Total: ${files.length} files, ${formatBytes(totalSize)}`);
    process.exit(0);
  }

  // Download
  logger.info(
    `Downloading with concurrency ${cli.concurrency}...`
  );
  console.log("");

  const result = await downloadAll(
    drive,
    files,
    outDir,
    cli.concurrency,
    logger
  );

  console.log("");
  logger.success(
    `Downloaded: ${result.downloaded} files (${formatBytes(result.totalBytes)})`
  );
  if (result.skipped > 0) {
    logger.info(`Skipped (already exists): ${result.skipped}`);
  }
  if (result.errors.length > 0) {
    logger.warn(`Errors: ${result.errors.length}`);
    for (const err of result.errors) {
      logger.error(`  ${err}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\x1b[31m[fatal]\x1b[0m ${err.message ?? err}`);
  process.exit(1);
});
