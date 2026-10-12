/**
 * Configuration bundles (report §3 `configuration.sources`).
 *
 * A bundle is a reusable, versioned set of agent configuration files (Codex,
 * Claude Code, OpenCode, MCP servers, skills, instructions) that an
 * environment profile can name as a configuration source. Bundles are stored
 * centrally and written into a sandbox at provisioning time, which keeps
 * configuration portable and independent from the environment image.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface ConfigFile {
  /** `~/`-relative to the sandbox home, or an absolute path inside the sandbox. */
  path: string;
  content: string;
  mode?: number;
  /** Where the file came from on the importing machine, for auditing. */
  source: string;
}

export interface ConfigBundle {
  name: string;
  version: number;
  createdAt: number;
  files: ConfigFile[];
  /** Non-secret environment values the agent configs expect. */
  env: Record<string, string>;
  warnings: string[];
}

export class ConfigBundleStore {
  constructor(private readonly root: string) {
    fs.mkdirSync(this.root, { recursive: true });
  }

  private file(name: string): string {
    return path.join(this.root, `${name.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  }

  save(bundle: ConfigBundle): void {
    fs.writeFileSync(this.file(bundle.name), JSON.stringify(bundle, null, 2), "utf8");
  }

  get(name: string): ConfigBundle | null {
    const file = this.file(name);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as ConfigBundle;
  }

  list(): Array<{ name: string; version: number; files: number }> {
    return fs
      .readdirSync(this.root)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const bundle = JSON.parse(
          fs.readFileSync(path.join(this.root, f), "utf8"),
        ) as ConfigBundle;
        return { name: bundle.name, version: bundle.version, files: bundle.files.length };
      });
  }

  /**
   * Resolve the `configuration.sources` of a profile into concrete files.
   * `git` sources read from an already-cloned repository checkout; `profile`
   * and `path` sources name stored bundles.
   */
  resolveSources(
    sources: Array<{ git: string } | { profile: string } | { path: string }>,
    options: { repositoryRoot?: string } = {},
  ): { files: ConfigFile[]; env: Record<string, string>; warnings: string[] } {
    const files: ConfigFile[] = [];
    const env: Record<string, string> = {};
    const warnings: string[] = [];

    for (const source of sources) {
      if ("git" in source) {
        const root = options.repositoryRoot;
        if (!root) {
          warnings.push(`git source ${source.git} skipped: no repository checkout`);
          continue;
        }
        const dir = path.join(root, source.git);
        if (!fs.existsSync(dir)) {
          warnings.push(`git source ${source.git} not found in repository`);
          continue;
        }
        for (const file of walkFiles(dir)) {
          const rel = path.relative(dir, file);
          files.push({
            path: `~/agents/${rel.split(path.sep).join("/")}`,
            content: fs.readFileSync(file, "utf8"),
            source: `${source.git}/${rel}`,
          });
        }
        continue;
      }

      const name = "profile" in source ? source.profile : source.path;
      const bundle = this.get(name);
      if (!bundle) {
        warnings.push(`configuration source ${name} not found`);
        continue;
      }
      files.push(...bundle.files);
      Object.assign(env, bundle.env);
      warnings.push(...bundle.warnings.map((w) => `${name}: ${w}`));
    }

    return { files, env, warnings };
  }
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}
