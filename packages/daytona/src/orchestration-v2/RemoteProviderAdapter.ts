/**
 * Remote provider adapter (report §2 Finding A).
 *
 * T3's provider adapters are reused *inside* the sandbox; this adapter is the
 * VPS-side proxy of them. It speaks the same operation set as T3's
 * `ProviderAdapterV2` (open/ensure/resume thread, start/interrupt/steer turn,
 * runtime requests, rollback, fork, event stream) and forwards each operation
 * over the worker protocol. It carries no per-provider business logic.
 *
 * Events come back normalized and T3-shaped, and are replayed from the durable
 * event store before switching to live traffic, so a client reconnect or a
 * control-plane restart loses nothing.
 */

import type {
  ProviderCapabilities,
  ProviderEventPayload,
  ProviderInventoryEntry,
  SessionOpenPayload,
} from "../contracts/workerProtocol.js";
import type { ProviderRuntimePort } from "../contracts/execution.js";
import {
  CapabilityUnsupportedError,
  ExecutionTargetUnavailableError,
} from "../contracts/errors.js";
import { newEffectId } from "../contracts/ids.js";
import type { EventStore, StoredEvent } from "../execution/EventStore.js";
import type { WorkerConnectionRegistry } from "../execution/WorkerConnectionRegistry.js";

const PROVIDER_EVENT_TYPES = new Set([
  "session.updated",
  "thread.updated",
  "turn.updated",
  "message.updated",
  "node.updated",
  "runtime_request.updated",
  "plan.updated",
  "turn.terminal",
  "worker.log",
]);

export function isProviderEvent(event: StoredEvent): boolean {
  return PROVIDER_EVENT_TYPES.has(event.type);
}

/** Minimal async queue backing the `events()` async iterable. */
class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiters: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined as never, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.items.length > 0) {
        yield this.items.shift()!;
        continue;
      }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (result.done) return;
      yield result.value;
    }
  }
}

export interface RemoteProviderAdapterOptions {
  driver: string;
  taskId: string;
  store: EventStore;
  registry: WorkerConnectionRegistry;
  /** Replay already-persisted events before streaming live ones. */
  replayFromSeq?: number;
}

export class RemoteProviderAdapter implements ProviderRuntimePort {
  readonly driver: string;
  private readonly taskId: string;
  private readonly store: EventStore;
  private readonly registry: WorkerConnectionRegistry;
  private readonly queue = new AsyncQueue<ProviderEventPayload>();
  private detach: (() => void) | null = null;

  constructor(options: RemoteProviderAdapterOptions) {
    this.driver = options.driver;
    this.taskId = options.taskId;
    this.store = options.store;
    this.registry = options.registry;

    // Subscribe first so nothing slips between replay and live subscription.
    this.detach = this.registry.onEvents((events) => {
      for (const event of events) {
        if (event.taskId !== this.taskId || !isProviderEvent(event)) continue;
        this.queue.push(event.payload as unknown as ProviderEventPayload);
      }
    });
    if (options.replayFromSeq !== undefined) void this.replay(options.replayFromSeq);
  }

  private async replay(fromSeq: number): Promise<void> {
    for (const event of this.store.eventsSince(this.taskId, fromSeq)) {
      if (isProviderEvent(event)) {
        this.queue.push(event.payload as unknown as ProviderEventPayload);
      }
    }
  }

  capabilities(): ProviderCapabilities {
    const entry = this.registry.providersFor(this.taskId).find((p) => p.driver === this.driver);
    if (!entry) {
      return {
        fork: false,
        rollback: false,
        steer: false,
        subagents: false,
        background: false,
        nativeResume: false,
        approvals: true,
      };
    }
    return entry.capabilities;
  }

  inventory(): ProviderInventoryEntry {
    return { driver: this.driver, capabilities: this.capabilities(), version: "remote" };
  }

  private requireCapability(capability: keyof ProviderCapabilities): void {
    if (!this.capabilities()[capability]) {
      throw new CapabilityUnsupportedError(this.driver, capability);
    }
  }

  private effectId(explicit?: string): string {
    return explicit ?? newEffectId();
  }

  private ensureAttached(): void {
    if (!this.registry.isConnected(this.taskId)) {
      throw new ExecutionTargetUnavailableError(
        this.taskId,
        "provider session runs in a sandbox whose worker is not attached",
      );
    }
  }

  async openSession(input: SessionOpenPayload): Promise<void> {
    this.ensureAttached();
    await this.registry.sendCommand(
      this.taskId,
      "session.open",
      { ...input, driver: this.driver },
      { effectId: this.effectId() },
    );
  }

  async closeSession(providerSessionId: string): Promise<void> {
    this.ensureAttached();
    await this.registry.sendCommand(
      this.taskId,
      "session.close",
      { driver: this.driver, providerSessionId },
      { effectId: this.effectId() },
    );
  }

  async ensureThread(input: {
    threadId: string;
    title?: string;
    providerSessionId?: string;
    existingProviderThread?: unknown;
    model: string;
    runtimePolicy: SessionOpenPayload["runtimePolicy"];
  }): Promise<{ providerThreadId: string }> {
    this.ensureAttached();
    return (await this.registry.sendCommand(
      this.taskId,
      "thread.ensure",
      { ...input, driver: this.driver },
      { effectId: this.effectId() },
    )) as { providerThreadId: string };
  }

  async resumeThread(input: { threadId: string; providerThreadId: string }): Promise<void> {
    this.ensureAttached();
    await this.registry.sendCommand(
      this.taskId,
      "thread.resume",
      { ...input, driver: this.driver },
      { effectId: this.effectId() },
    );
  }

  async startTurn(
    input: {
      threadId: string;
      runId: string;
      runOrdinal: number;
      providerTurnOrdinal: number;
      attemptId: string;
      message: {
        messageId: string;
        text: string;
        attachments: unknown[];
        createdBy: string;
        creationSource: string;
      };
      model: string;
      runtimePolicy: SessionOpenPayload["runtimePolicy"];
    },
    effectId?: string,
  ): Promise<void> {
    this.ensureAttached();
    await this.registry.sendCommand(
      this.taskId,
      "turn.start",
      { ...input, driver: this.driver },
      { effectId: this.effectId(effectId), threadId: input.threadId, runId: input.runId },
    );
  }

  async interrupt(
    input: { threadId: string; runId: string; providerTurnId: string },
    effectId?: string,
  ): Promise<void> {
    this.ensureAttached();
    await this.registry.sendCommand(
      this.taskId,
      "turn.interrupt",
      { ...input, driver: this.driver },
      { effectId: this.effectId(effectId), threadId: input.threadId, runId: input.runId },
    );
  }

  async steer(input: {
    threadId: string;
    runId: string;
    providerTurnId: string;
    text: string;
  }): Promise<void> {
    this.requireCapability("steer");
    this.ensureAttached();
    await this.registry.sendCommand(
      this.taskId,
      "turn.steer",
      { ...input, driver: this.driver },
      { effectId: this.effectId(), threadId: input.threadId, runId: input.runId },
    );
  }

  async respondRuntimeRequest(
    input: {
      requestId: string;
      decision: "approved" | "rejected" | "cancelled";
      answer?: unknown;
    },
    effectId?: string,
  ): Promise<void> {
    this.ensureAttached();
    await this.registry.sendCommand(
      this.taskId,
      "runtime_request.respond",
      { ...input, driver: this.driver },
      { effectId: this.effectId(effectId) },
    );
  }

  async rollbackThread(
    input: { threadId: string; providerThreadId: string; checkpointId?: string },
    effectId?: string,
  ): Promise<void> {
    this.requireCapability("rollback");
    this.ensureAttached();
    await this.registry.sendCommand(
      this.taskId,
      "thread.rollback",
      { ...input, driver: this.driver },
      { effectId: this.effectId(effectId), threadId: input.threadId },
    );
  }

  async forkThread(input: { threadId: string; providerThreadId: string }): Promise<void> {
    this.requireCapability("fork");
    this.ensureAttached();
    await this.registry.sendCommand(
      this.taskId,
      "thread.fork",
      { ...input, driver: this.driver },
      { effectId: this.effectId(), threadId: input.threadId },
    );
  }

  events(): AsyncIterable<ProviderEventPayload> {
    return this.queue;
  }

  /** Stop streaming; safe to call more than once. */
  close(): void {
    this.detach?.();
    this.detach = null;
    this.queue.close();
  }
}
