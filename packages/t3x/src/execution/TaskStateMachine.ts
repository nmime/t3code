/**
 * Task execution state machine (report §5 "Task state machine").
 *
 * States and legal transitions live in the contracts package; this module
 * enforces them against the durable task projection and records the resulting
 * domain event, so an illegal transition can never be persisted — e.g.
 * starting a turn on a suspended task.
 */

import {
  TASK_STATE_TRANSITIONS,
  canTransition,
  TERMINAL_TASK_STATES,
  type TaskExecutionState,
  type TaskRecord,
} from "../contracts/execution.js";
import { TaskNotFoundError, TaskStateError } from "../contracts/errors.js";
import type { EventStore } from "./EventStore.js";

export interface TransitionResult {
  from: TaskExecutionState;
  to: TaskExecutionState;
  task: TaskRecord;
}

/** The states a new turn may start in. */
const MESSAGE_ACCEPTING_STATES: TaskExecutionState[] = ["ready", "waiting", "running"];

export class TaskStateMachine {
  constructor(private readonly store: EventStore) {}

  /** Move a task to `to`, in one transaction with its domain event. */
  transition(
    taskId: string,
    to: TaskExecutionState,
    detail: Record<string, unknown> = {},
  ): TransitionResult {
    const record = this.store.getTask(taskId);
    if (!record) throw new TaskNotFoundError(taskId);
    const from = record.state;

    if (from === to) return { from, to, task: record };
    if (!canTransition(from, to)) {
      throw new TaskStateError(
        taskId,
        from,
        `cannot transition to ${to} (legal next: ${TASK_STATE_TRANSITIONS[from].join(", ")})`,
      );
    }

    const patch: Partial<TaskRecord> = { state: to };
    if (to === "completed" || to === "failed") {
      patch.completedAt = Date.now();
      patch.idleSince = null;
    }
    if (to === "ready") patch.idleSince = Date.now();
    if (to === "running") patch.idleSince = null;

    this.store.db.tx(() => {
      this.store.updateTask(taskId, patch);
      this.store.appendEvents(taskId, "task", [
        { type: "task.state_changed", payload: { from, to, ...detail } },
      ]);
    });

    return { from, to, task: this.store.getTask(taskId)! };
  }

  /** Guard for message handling: only these states accept new turns. */
  assertAcceptsMessages(taskId: string): TaskRecord {
    const record = this.store.getTask(taskId);
    if (!record) throw new TaskNotFoundError(taskId);
    if (!MESSAGE_ACCEPTING_STATES.includes(record.state)) {
      throw new TaskStateError(taskId, record.state, "task does not accept messages");
    }
    return record;
  }

  /**
   * Whether a message to this task is a turn.
   *
   * `false` does not mean the message is refused: a task the idle policy
   * suspended, or one whose environment is still coming up, is woken by the
   * message (`TaskService.sendMessage` queues `task.ensure_ready` ahead of the
   * turn). Only `isTerminal` is a refusal.
   */
  acceptsMessages(taskId: string): boolean {
    const record = this.store.getTask(taskId);
    if (!record) throw new TaskNotFoundError(taskId);
    return MESSAGE_ACCEPTING_STATES.includes(record.state);
  }

  isTerminal(state: TaskExecutionState): boolean {
    return TERMINAL_TASK_STATES.includes(state);
  }
}
