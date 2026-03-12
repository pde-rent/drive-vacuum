# drive-vacuum

Recursively download all files from a Google Drive folder using a service account.

```
     ____________
    [____________]
     |  ◉    ◉  |
     | DRIVE    |
     |   VACUUM |
     |___|  |___|
    /====|  |====\
   |_____|__|_____|
      @        @
```

## Features

- Recursive folder traversal with full structure preservation
- Google Workspace exports (Docs to Markdown, Sheets to CSV, Slides to PDF, Drawings to PNG)
- Gitignore-style filtering via `.vacuumignore`
- Concurrent downloads with configurable parallelism
- Shortcut resolution
- Skip-if-exists (name + size match)
- Dry-run mode for previewing
- Service account JWT authentication

## Setup

```bash
bun install
```

### Service account

1. Create a service account in the Google Cloud Console
2. Enable the Google Drive API
3. Download the JSON key file
4. Share the target Drive folder with the service account email

## Usage

```bash
# Basic usage with folder ID
bun run src/index.ts 1A2B3C4D5E --key ./service-account.json

# With a full URL
bun run src/index.ts https://drive.google.com/drive/folders/1A2B3C4D5E

# Custom output directory and concurrency
bun run src/index.ts 1A2B3C4D5E -o ./backup -c 10 -k ./sa-key.json

# Dry run (list files without downloading)
bun run src/index.ts 1A2B3C4D5E --dry-run --key ./sa-key.json

# Using environment variable for the key
export GOOGLE_SERVICE_ACCOUNT_KEY=./sa-key.json
bun run src/index.ts 1A2B3C4D5E

# Verbose output
bun run src/index.ts 1A2B3C4D5E -v --key ./sa-key.json
```

After linking (`bun link`), you can also run it directly:

```bash
drive-vacuum 1A2B3C4D5E --key ./sa-key.json
```

## Options

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--out` | `-o` | `./drive-dump` | Output directory |
| `--key` | `-k` | env `GOOGLE_SERVICE_ACCOUNT_KEY` | Path to service account JSON key |
| `--ignore` | `-i` | `.vacuumignore` | Path to ignore file |
| `--dry-run` | - | `false` | List files without downloading |
| `--concurrency` | `-c` | `5` | Max concurrent downloads |
| `--verbose` | `-v` | `false` | Show debug output |
| `--help` | `-h` | - | Show help |

## Ignore file

Create a `.vacuumignore` file (gitignore syntax):

```gitignore
# Skip large archives
*.zip
*.tar.gz

# Skip directories
node_modules/
.git/

# Glob patterns
temp_*

# Negation: include this even if matched above
!important.zip
```

Built-in ignores (always active): `.DS_Store`, `Thumbs.db`

## Google Workspace exports

| Source | Export format |
|--------|-------------|
| Google Docs | Markdown (.md) |
| Google Sheets | CSV (.csv) |
| Google Slides | PDF (.pdf) |
| Google Drawings | PNG (.png) |

Files that cannot be exported (Forms, Sites, Apps Script) are skipped automatically.
