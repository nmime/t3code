/**
 * Local configuration importer (report §3 "Mac-to-Linux configuration
 * migration").
 *
 * Discovers and selectively imports local agent setups:
 *   - `~/.codex/config.toml`, non-sensitive skills and instructions
 *   - Claude settings, commands, hooks and project instructions
 *   - OpenCode's `opencode.json`, custom providers and plugins
 *   - non-secret environment values referenced by those configs
 *
 * It must not blindly copy a home directory: macOS binaries, Homebrew paths,
 * Keychain references and machine-specific environment values cannot run in a
 * Linux sandbox, and credentials are stripped into the secrets broker.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ConfigBundle, ConfigFile } from "./ConfigBundle.js";
import { findMacSpecificLines, redactJson, redactTomlLike } from "./redact.js";

export type ImportTarget = "codex" | "claude" | "opencode";

export interface ImportOptions {
  /** Source home directory, e.g. `/Users/me` on the Mac. */
  home: string;
  targets?: ImportTarget[];
  name: string;
  maxFileBytes?: number;
}

export interface ImportResult {
  bundle: ConfigBundle;
  imported: string[];
  skipped: string[];
}

export function importLocalConfigs(options: ImportOptions): ImportResult {
  const targets = options.targets ?? ["codex", "claude", "opencode"];
  const maxFileBytes = options.maxFileBytes ?? 256 * 1024;
  const files: ConfigFile[] = [];
  const env: Record<string, string> = {};
  const warnings: string[] = [];
  const imported: string[] = [];
  const skipped: string[] = [];

  const addFile = (
    sourcePath: string,
    bundlePath: string,
    transform: (text: string) => { text: string; warnings?: string[] },
  ): void => {
    if (!fs.existsSync(sourcePath)) {
      skipped.push(sourcePath);
      return;
    }
    const stat = fs.statSync(sourcePath);
    if (!stat.isFile()) {
      skipped.push(sourcePath);
      return;
    }
    if (stat.size > maxFileBytes) {
      skipped.push(`${sourcePath} (too large: ${stat.size} bytes)`);
      return;
    }
    const raw = fs.readFileSync(sourcePath, "utf8");
    const { text, warnings: fileWarnings } = transform(raw);
    const macLines = findMacSpecificLines(text);
    if (macLines.length > 0) {
      warnings.push(
        `${sourcePath}: macOS-specific lines kept verbatim, review before use: ${macLines.join("; ")}`,
      );
    }
    files.push({ path: bundlePath, content: text, source: sourcePath });
    for (const warning of fileWarnings ?? []) warnings.push(`${sourcePath}: ${warning}`);
    imported.push(`${sourcePath} -> ${bundlePath}`);
  };

  const addTree = (sourceDir: string, bundleDir: string, extensions?: string[]): void => {
    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
      skipped.push(sourceDir);
      return;
    }
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      const full = path.join(sourceDir, entry.name);
      if (entry.isDirectory()) {
        addTree(full, `${bundleDir}/${entry.name}`, extensions);
        continue;
      }
      if (!entry.isFile()) continue;
      if (extensions && !extensions.some((ext) => entry.name.endsWith(ext))) {
        skipped.push(`${full} (extension not imported)`);
        continue;
      }
      addFile(full, `${bundleDir}/${entry.name}`, (text) => ({ text }));
    }
  };

  if (targets.includes("codex")) {
    const codexHome = path.join(options.home, ".codex");
    addFile(path.join(codexHome, "config.toml"), "~/.codex/config.toml", (text) => {
      const { text: redacted, redactedKeys } = redactTomlLike(text);
      return {
        text: redacted,
        warnings:
          redactedKeys.length > 0 ? [`redacted credential keys: ${redactedKeys.join(", ")}`] : [],
      };
    });
    addTree(path.join(codexHome, "skills"), "~/.codex/skills", [".md", ".json", ".yaml", ".yml"]);
    addFile(path.join(codexHome, "AGENTS.md"), "~/.codex/AGENTS.md", (text) => ({ text }));
  }

  if (targets.includes("claude")) {
    const claudeHome = path.join(options.home, ".claude");
    addFile(path.join(claudeHome, "settings.json"), "~/.claude/settings.json", (text) => {
      try {
        const parsed = JSON.parse(text) as unknown;
        const { value, redactedKeys } = redactJson(parsed);
        return {
          text: JSON.stringify(value, null, 2),
          warnings:
            redactedKeys.length > 0 ? [`redacted credential keys: ${redactedKeys.join(", ")}`] : [],
        };
      } catch {
        return { text, warnings: ["settings.json is not valid JSON; imported verbatim"] };
      }
    });
    addTree(path.join(claudeHome, "commands"), "~/.claude/commands");
    addTree(path.join(claudeHome, "hooks"), "~/.claude/hooks");
    addFile(path.join(claudeHome, "CLAUDE.md"), "~/.claude/CLAUDE.md", (text) => ({ text }));
  }

  if (targets.includes("opencode")) {
    const openCodeHome = path.join(options.home, ".config", "opencode");
    for (const candidate of ["opencode.json", "opencode.jsonc"]) {
      addFile(path.join(openCodeHome, candidate), `~/.config/opencode/${candidate}`, (text) => {
        try {
          const parsed = JSON.parse(text) as unknown;
          const { value, redactedKeys } = redactJson(parsed);
          return {
            text: JSON.stringify(value, null, 2),
            warnings:
              redactedKeys.length > 0
                ? [`redacted credential keys: ${redactedKeys.join(", ")}`]
                : [],
          };
        } catch {
          return { text, warnings: ["config is not valid JSON; imported verbatim"] };
        }
      });
    }
    addTree(path.join(openCodeHome, "plugin"), "~/.config/opencode/plugin");
    addTree(path.join(openCodeHome, "agent"), "~/.config/opencode/agent");
  }

  // Environment values referenced by configs are imported as non-secret only.
  const envFile = path.join(options.home, ".t3x", "env.json");
  if (fs.existsSync(envFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(envFile, "utf8")) as Record<string, string>;
      const { value, redactedKeys } = redactJson(parsed);
      Object.assign(env, value);
      if (redactedKeys.length > 0) {
        warnings.push(`env.json: redacted keys ${redactedKeys.join(", ")}`);
      }
    } catch {
      warnings.push("env.json is not valid JSON; skipped");
    }
  }

  return {
    bundle: { name: options.name, version: 1, createdAt: Date.now(), files, env, warnings },
    imported,
    skipped,
  };
}
