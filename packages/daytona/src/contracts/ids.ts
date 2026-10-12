/** Identifier helpers. Ids are opaque strings with a readable prefix. */

import { randomUUID, createHash } from "node:crypto";

export type TaskId = string;
export type ThreadId = string;
export type SandboxId = string;
export type EffectId = string;
export type CommandId = string;
export type EventId = string;
export type RunId = string;
export type CheckpointId = string;
export type ProfileId = string;

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export const newTaskId = (): TaskId => newId("task");
export const newThreadId = (): ThreadId => newId("thread");
export const newSandboxId = (): SandboxId => newId("sbox");
export const newEffectId = (): EffectId => newId("fx");
export const newCommandId = (): CommandId => newId("cmd");
export const newEventId = (): EventId => newId("evt");
export const newRunId = (): RunId => newId("run");
export const newRequestId = (): string => newId("req");
export const newTokenId = (): string => newId("tok");

/** Stable sha256 over a canonical JSON representation (see canonical.ts). */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
