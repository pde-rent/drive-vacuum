const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";
const GRAY = "\x1b[90m";

export interface Logger {
  info(msg: string): void;
  success(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
  progress(current: number, total: number, fileName: string, size?: number): void;
  banner(): void;
}

export function createLogger(verbose: boolean): Logger {
  return {
    info(msg: string) {
      console.log(`${BLUE}[info]${RESET} ${msg}`);
    },

    success(msg: string) {
      console.log(`${GREEN}[done]${RESET} ${msg}`);
    },

    warn(msg: string) {
      console.log(`${YELLOW}[warn]${RESET} ${msg}`);
    },

    error(msg: string) {
      console.error(`${RED}[error]${RESET} ${msg}`);
    },

    debug(msg: string) {
      if (verbose) {
        console.log(`${GRAY}[debug]${RESET} ${DIM}${msg}${RESET}`);
      }
    },

    progress(current: number, total: number, fileName: string, size?: number) {
      const pct = total > 0 ? Math.round((current / total) * 100) : 0;
      const sizeStr = size != null ? ` (${formatBytes(size)})` : "";
      const bar = progressBar(pct, 20);
      process.stdout.write(
        `\r${CYAN}${bar}${RESET} ${BOLD}${pct}%${RESET} [${current}/${total}] ${fileName}${sizeStr}  `
      );
      if (current === total) {
        process.stdout.write("\n");
      }
    },

    banner() {
      const art = `
${BOLD}${CYAN}     ____________
    [____________]
     |  ◉    ◉  |
     | DRIVE    |
     |   VACUUM |
     |___|  |___|
    /====|  |====\\
   |_____|__|_____|
      @        @${RESET}
`;
      console.log(art);
    },
  };
}

function progressBar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}
