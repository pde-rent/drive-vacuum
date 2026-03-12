const c = (code: string, tag: string, msg: string) =>
  console.log(`\x1b[${code}m[${tag}]\x1b[0m ${msg}`);

export const BANNER = `\n\x1b[1m\x1b[36m     ____________
    [____________]
     |  ◉    ◉  |
     | DRIVE    |
     |   VACUUM |
     |___|  |___|
    /====|  |====\\
   |_____|__|_____|
      @        @\x1b[0m\n`;

export function createLogger(verbose: boolean) {
  return {
    info: (msg: string) => c("34", "info", msg),
    success: (msg: string) => c("32", "done", msg),
    warn: (msg: string) => c("33", "warn", msg),
    error: (msg: string) => console.error(`\x1b[31m[error]\x1b[0m ${msg}`),
    debug: (msg: string) => { if (verbose) c("90", "debug", msg); },
    progress(cur: number, total: number, name: string, size?: number) {
      const pct = total > 0 ? Math.round((cur / total) * 100) : 0;
      const filled = Math.round((pct / 100) * 20);
      const bar = `[${"█".repeat(filled)}${"░".repeat(20 - filled)}]`;
      const s = size != null ? ` (${fmtBytes(size)})` : "";
      process.stdout.write(`\r\x1b[K\x1b[36m${bar}\x1b[0m \x1b[1m${pct}%\x1b[0m [${cur}/${total}] ${name}${s}`);
      if (cur === total) process.stdout.write("\n");
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;

export function fmtBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}
