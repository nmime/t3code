/**
 * Processed-effect ledger.
 *
 * Commands arrive with the `effectId` of the durable effect that produced
 * them. The worker records every executed effect and replays the original
 * result for a duplicate instead of executing again — which makes control
 * plane retries safe after a crash. A replay with a *different* payload is a
 * conflict and is refused.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { IdempotencyConflictError } from "../contracts/errors.js";
import { payloadHash } from "../contracts/workerProtocol.js";

interface LedgerEntry {
  hash: string;
  result: unknown;
  at: number;
}

export class CommandDedupe {
  private readonly file: string;
  private readonly entries = new Map<string, LedgerEntry>();
  private readonly maxEntries: number;

  constructor(stateDir: string, maxEntries = 1000) {
    this.file = path.join(stateDir, "dedupe.json");
    this.maxEntries = maxEntries;
    fs.mkdirSync(stateDir, { recursive: true });
    if (fs.existsSync(this.file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, LedgerEntry>;
        for (const [key, value] of Object.entries(raw)) this.entries.set(key, value);
      } catch {
        this.entries.clear();
      }
    }
  }

  lookup(
    effectId: string | undefined,
    command: { type: string; payload: unknown },
  ): { duplicate: boolean; result: unknown } {
    if (!effectId) return { duplicate: false, result: null };
    const entry = this.entries.get(effectId);
    if (!entry) return { duplicate: false, result: null };
    const hash = payloadHash({ type: command.type, payload: command.payload });
    if (entry.hash !== hash) {
      throw new IdempotencyConflictError(
        effectId,
        `command ${command.type} was replayed with a different payload`,
      );
    }
    return { duplicate: true, result: entry.result };
  }

  record(
    effectId: string | undefined,
    command: { type: string; payload: unknown },
    result: unknown,
  ): void {
    if (!effectId) return;
    this.entries.set(effectId, {
      hash: payloadHash({ type: command.type, payload: command.payload }),
      result,
      at: Date.now(),
    });
    if (this.entries.size > this.maxEntries) {
      const sorted = [...this.entries.entries()].sort((a, b) => a[1].at - b[1].at);
      for (const [key] of sorted.slice(0, this.entries.size - this.maxEntries)) {
        this.entries.delete(key);
      }
    }
    fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.entries)), "utf8");
  }

  size(): number {
    return this.entries.size;
  }
}
