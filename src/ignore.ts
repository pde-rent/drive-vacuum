import { existsSync, readFileSync } from "node:fs";

interface Rule { re: RegExp; neg: boolean; dirOnly: boolean }

function globToRe(glob: string): RegExp {
  let re = "", i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      re += glob[i + 2] === "/" ? "(.+/)?" : "(.*/)?";
      i += glob[i + 2] === "/" ? 3 : 2;
    } else if (ch === "*") { re += "[^/]*"; i++; }
    else if (ch === "?") { re += "[^/]"; i++; }
    else { re += ".+^${}()|[]\\".includes(ch!) ? "\\" + ch : ch; i++; }
  }
  return new RegExp(`^${re}$`);
}

function parse(lines: string[]): Rule[] {
  return lines.reduce<Rule[]>((rules, raw) => {
    const line = raw.trim();
    if (!line || line[0] === "#") return rules;
    let p = line, neg = false, dirOnly = false;
    if (p[0] === "!") { neg = true; p = p.slice(1); }
    if (p.at(-1) === "/") { dirOnly = true; p = p.slice(0, -1); }
    rules.push({ re: globToRe(p), neg, dirOnly });
    return rules;
  }, []);
}

export function createIgnoreMatcher(filePath?: string) {
  const rules = [
    ...parse([".DS_Store", "Thumbs.db"]),
    ...(filePath && existsSync(filePath)
      ? parse(readFileSync(filePath, "utf-8").split("\n")) : []),
  ];
  return {
    isIgnored(path: string, isDir = false): boolean {
      const base = path.slice(path.lastIndexOf("/") + 1);
      let ignored = false;
      for (const r of rules) {
        if (r.dirOnly && !isDir) continue;
        if (r.re.test(path) || r.re.test(base)) ignored = !r.neg;
      }
      return ignored;
    },
  };
}

export type IgnoreMatcher = ReturnType<typeof createIgnoreMatcher>;
