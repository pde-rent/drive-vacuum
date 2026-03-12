/**
 * Gitignore-like pattern matcher for filtering files during download.
 *
 * Supports:
 *   - Comments (#)
 *   - Blank lines (skipped)
 *   - Negation (!pattern) to re-include previously excluded files
 *   - Glob wildcards (* matches anything except /, ** matches everything)
 *   - Extension patterns (*.pdf)
 *   - Directory patterns (dirname/)
 *   - Exact name matches
 */

import { existsSync, readFileSync } from "node:fs";

interface Rule {
  pattern: RegExp;
  negated: boolean;
  directoryOnly: boolean;
}

export class IgnoreMatcher {
  private rules: Rule[] = [];

  constructor(patterns: string[] = []) {
    // Built-in ignores
    this.addPatterns([".DS_Store", "Thumbs.db"]);
    this.addPatterns(patterns);
  }

  /** Load patterns from a file. Missing file is not an error. */
  static fromFile(filePath: string): IgnoreMatcher {
    const matcher = new IgnoreMatcher();
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      matcher.addPatterns(lines);
    }
    return matcher;
  }

  addPatterns(lines: string[]): void {
    for (const raw of lines) {
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) continue;

      let pattern = line;
      let negated = false;
      let directoryOnly = false;

      if (pattern.startsWith("!")) {
        negated = true;
        pattern = pattern.slice(1);
      }

      if (pattern.endsWith("/")) {
        directoryOnly = true;
        pattern = pattern.slice(0, -1);
      }

      const regex = globToRegex(pattern);
      this.rules.push({ pattern: regex, negated, directoryOnly });
    }
  }

  /**
   * Check whether a relative path should be ignored.
   *
   * @param relativePath  forward-slash path relative to the output root
   * @param isDirectory   true when the entry is a folder
   * @returns true if the path should be skipped
   */
  isIgnored(relativePath: string, isDirectory: boolean = false): boolean {
    // Test against the full relative path AND the basename
    const basename = relativePath.split("/").pop() ?? relativePath;

    let ignored = false;

    for (const rule of this.rules) {
      if (rule.directoryOnly && !isDirectory) continue;

      const matches =
        rule.pattern.test(relativePath) || rule.pattern.test(basename);

      if (matches) {
        ignored = !rule.negated;
      }
    }

    return ignored;
  }
}

/**
 * Convert a gitignore-style glob pattern to a RegExp.
 *
 * Rules:
 *   - `**` matches everything (including `/`)
 *   - `*`  matches everything except `/`
 *   - `?`  matches a single character except `/`
 *   - Special regex chars are escaped
 *   - Patterns without `/` are matched against basenames too
 */
function globToRegex(glob: string): RegExp {
  let re = "";
  let i = 0;

  while (i < glob.length) {
    const ch = glob[i];

    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // ** matches everything
        if (glob[i + 2] === "/") {
          re += "(.+/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        // * matches everything except /
        re += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else if (".+^${}()|[]\\".includes(ch!)) {
      re += "\\" + ch;
      i++;
    } else {
      re += ch;
      i++;
    }
  }

  return new RegExp(`^${re}$`);
}
