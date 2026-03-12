#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createLogger, fmtBytes, BANNER } from "./logger";
import { createIgnoreMatcher } from "./ignore";
import { createDriveClient, listFiles, downloadAll, extractFolderId } from "./drive";

// Arg parsing (data-driven)

const BOOL_FLAGS: Record<string, string> = {
  "--help": "help", "-h": "help", "--verbose": "verbose", "-v": "verbose", "--dry-run": "dryRun",
};
const VAL_FLAGS: Record<string, string> = {
  "--out": "outDir", "-o": "outDir", "--key": "keyFile", "-k": "keyFile",
  "--ignore": "ignoreFile", "-i": "ignoreFile", "--concurrency": "concurrency", "-c": "concurrency",
};

function parseArgs(argv: string[]) {
  const cli: Record<string, any> = {
    folder: null, outDir: "./drive-dump", keyFile: null,
    ignoreFile: ".vacuumignore", dryRun: false, concurrency: 5, verbose: false, help: false,
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (BOOL_FLAGS[a]) cli[BOOL_FLAGS[a]] = true;
    else if (VAL_FLAGS[a]) { const v = args[++i]; cli[VAL_FLAGS[a]] = a.includes("concurrency") ? (parseInt(v, 10) || 5) : v; }
    else if (!a.startsWith("-") && !cli.folder) cli.folder = a;
    else if (a.startsWith("-")) { console.error(`Unknown option: ${a}`); process.exit(1); }
  }
  return cli;
}

const HELP = `${BANNER}
  Recursively download all files from a Google Drive folder.

  USAGE
    drive-vacuum <folder-id-or-url> [options]

  OPTIONS
    --out, -o <dir>         Output directory (default: ./drive-dump)
    --key, -k <path>        Service account JSON key (default: env GOOGLE_SERVICE_ACCOUNT_KEY)
    --ignore, -i <path>     Ignore file (default: .vacuumignore)
    --dry-run               List files without downloading
    --concurrency, -c <n>   Parallel downloads (default: 5)
    --verbose, -v           Debug output
    --help, -h              Show this help

  EXPORTS  Docs->DOCX  Sheets->XLSX  Slides->PDF  Drawings->SVG

  EXAMPLES
    drive-vacuum 1A2B3C4D5E -o ./backup -k ./sa.json
    drive-vacuum https://drive.google.com/drive/folders/1A2B3C4D5E --dry-run
`;

async function main() {
  const cli = parseArgs(process.argv);
  if (cli.help) { console.log(HELP); process.exit(0); }

  const log = createLogger(cli.verbose);
  console.log(BANNER);

  if (!cli.folder) { log.error("Missing folder ID or URL. Run with --help."); process.exit(1); }
  const folderId = extractFolderId(cli.folder);
  log.info(`Folder: ${folderId}`);

  const keyFile = cli.keyFile ?? process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyFile) { log.error("No key. Use --key or set GOOGLE_SERVICE_ACCOUNT_KEY."); process.exit(1); }
  const keyPath = resolve(keyFile);
  if (!existsSync(keyPath)) { log.error(`Key not found: ${keyPath}`); process.exit(1); }

  const ignore = createIgnoreMatcher(resolve(cli.ignoreFile));
  const outDir = resolve(cli.outDir);
  log.info(`Output: ${outDir}`);
  if (cli.dryRun) log.info("DRY RUN");

  log.info("Authenticating...");
  const drive = await createDriveClient(keyPath);

  log.info("Scanning...");
  const files = await listFiles(drive, folderId, log, ignore);
  const totalSize = files.reduce((s, f) => s + f.size, 0);
  log.info(`Found ${files.length} files (${fmtBytes(totalSize)})`);

  if (!files.length) { log.warn("Nothing to download."); process.exit(0); }

  if (cli.dryRun) {
    console.log("");
    for (const f of files) {
      const sz = f.size > 0 ? fmtBytes(f.size) : "(workspace)";
      console.log(`  ${f.relativePath}  ${sz}${f.exportExt ? ` [${f.exportExt}]` : ""}`);
    }
    log.info(`Total: ${files.length} files, ${fmtBytes(totalSize)}`);
    process.exit(0);
  }

  log.info(`Downloading (concurrency: ${cli.concurrency})...`);
  console.log("");
  const res = await downloadAll(drive, files, outDir, cli.concurrency, log);
  console.log("");
  log.success(`Downloaded: ${res.downloaded} files (${fmtBytes(res.totalBytes)})`);
  if (res.skipped) log.info(`Skipped: ${res.skipped}`);
  if (res.errors.length) { log.warn(`Errors: ${res.errors.length}`); res.errors.forEach(e => log.error(`  ${e}`)); process.exit(1); }
}

main().catch(err => { console.error(`\x1b[31m[fatal]\x1b[0m ${err.message ?? err}`); process.exit(1); });
