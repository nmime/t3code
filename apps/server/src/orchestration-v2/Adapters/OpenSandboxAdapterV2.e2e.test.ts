/**
 * The OpenSandbox adapter through T3's real orchestration path.
 *
 * Every other test in this integration stops at the control-plane boundary: it
 * proves the client, the control plane and the worker agree with each other.
 * This one starts where a user does — a `thread.create` and a `message.dispatch`
 * command — and runs the real orchestrator, provider session manager, turn
 * start service, run execution service and `ProviderEventIngestor` over the
 * OpenSandbox adapter, against a real control plane, a real sandbox directory and a
 * real worker process. What it asserts is what T3's own projection holds
 * afterwards, which is what the UI would render.
 *
 * The control plane is imported from `packages/t3x/dist`, because the
 * control plane spawns the worker from the build next to it. `pnpm -r test`
 * builds it before this package's tests run; a developer running this file
 * alone needs `pnpm --filter @t3tools/t3x build` first.
 *
 * @module orchestration-v2/Adapters/OpenSandboxAdapterV2.e2e.test
 */
// @effect-diagnostics nodeBuiltinImport:off -- the fixture makes a git checkout and a state directory
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import {
  OPENSANDBOX_DRIVER,
  OpenSandboxControlPlane,
  OpenSandboxDriver,
} from "@t3tools/provider-opensandbox/server";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { layerWithRegistry } from "../testkit/ProviderReplayHarness.ts";
import { runOrchestratorV2Scenario } from "../testkit/OrchestratorScenario.ts";
import { ControlPlaneServer } from "../../../../../packages/t3x/dist/src/execution/ControlPlaneServer.js";
import { ProcessWorkerLauncher } from "../../../../../packages/t3x/dist/src/execution/SandboxControlPlane.js";

const instanceId = ProviderInstanceId.make("opensandbox_e2e");

const profile = {
  apiVersion: "t3-daytona/v1",
  kind: "EnvironmentProfile",
  metadata: { name: "provider-test", version: 1 },
  runtime: { snapshot: "node24-dev-v3", resources: { cpu: 2, memoryGiB: 4 } },
  project: { workingDirectory: "/workspace/project", setup: [] },
  environment: { NODE_ENV: "development" },
  agents: { allowed: ["echo", "codex"], defaults: { provider: "echo" } },
};

/** A real checkout, so the task gets a worktree in a shared project sandbox. */
const makeRepository = (): string => {
  const origin = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3x-e2e-origin-"));
  const run = (command: string) =>
    NodeChildProcess.spawnSync("bash", ["-c", command], { cwd: origin });
  run("git init -q -b main");
  run("git config user.email a@b.c");
  run("git config user.name t");
  NodeFS.writeFileSync(NodePath.join(origin, "README.md"), "# end to end\n");
  run("git add -A && git commit -qm init");
  return origin;
};

// The live clock: this test talks to a real control plane over HTTP and waits
// for real processes, so `Effect.sleep` has to be real time too.
it.live(
  "a dispatched message reaches T3's projection through the real ingestor",
  () =>
    Effect.gen(function* () {
      const repositoryUrl = makeRepository();
      const server = yield* Effect.promise(() =>
        ControlPlaneServer.start({
          stateDir: NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3x-e2e-state-")),
          port: 0,
          launcher: new ProcessWorkerLauncher(),
          // The control plane's own effect loop stays on: it is what starts the
          // turn in the sandbox after T3 dispatches a message.
          workerAttachTimeoutMs: 30_000,
        }),
      );
      yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()));
      server.profiles.createProfile({ profileId: "provider-test", body: profile as never });

      // The client is the test's own window into the control plane: the driver
      // builds its own for the adapter.
      const client = new OpenSandboxControlPlane({
        url: `http://127.0.0.1:${server.port}`,
        token: undefined,
      });
      // The real path, as the server builds it: a provider instance in the
      // settings config map, resolved by the OpenSandbox driver into an adapter —
      // the same `create` that `ProviderInstanceRegistry` calls in production.
      // Registering the adapter directly would skip the instance registry T3
      // needs to attribute a session to an instance.
      // The production path: a provider instance in the settings config map,
      // built by the v1 driver `apps/server` lists in BUILT_IN_DRIVERS, whose
      // `orchestrationAdapter` the orchestration runtime talks to. Building the
      // adapter directly would skip both the driver and the instance registry.
      const registryLayer = ProviderAdapterRegistry.layerFromProviderInstanceRegistry.pipe(
        Layer.provide(
          Layer.mergeAll(
            ProviderInstanceRegistry.layer({
              drivers: [OpenSandboxDriver],
              configMap: {
                [instanceId]: {
                  driver: OPENSANDBOX_DRIVER,
                  displayName: "OpenSandbox (end to end)",
                  config: {
                    controlPlaneUrl: `http://127.0.0.1:${server.port}`,
                    profileId: "provider-test",
                    agent: "echo",
                    repositoryUrl,
                    sandboxScope: "project",
                  },
                },
              },
            }),
            NodeServices.layer,
            TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
          ),
        ),
      );

      const threadId = ThreadId.make("thread:opensandbox-e2e");
      const secondThreadId = ThreadId.make("thread:opensandbox-e2e-second");
      const projectId = ProjectId.make("project:opensandbox-e2e");
      const commands: ReadonlyArray<OrchestrationV2Command> = [
        {
          type: "thread.create",
          commandId: CommandId.make("create:opensandbox-e2e"),
          threadId,
          projectId,
          title: "OpenSandbox end to end",
          modelSelection: { instanceId, model: "default" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        },
        {
          type: "message.dispatch",
          commandId: CommandId.make("dispatch:opensandbox-e2e"),
          threadId,
          messageId: MessageId.make("message:opensandbox-e2e"),
          text: "hello from T3",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        },
        // A second turn in the same thread: the session is already bound, so
        // this one does not create anything — it reuses the sandbox the first
        // turn started. Hosting the app found this failing while a fresh thread
        // worked, which is why it is here.
        {
          type: "message.dispatch",
          commandId: CommandId.make("dispatch:opensandbox-e2e-2"),
          threadId,
          messageId: MessageId.make("message:opensandbox-e2e-2"),
          text: "hello again from T3",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        },
        // A second thread on the same provider instance. The session is shared,
        // and the adapter used to read its tasks' event streams one after
        // another — which parks on the first task forever and leaves every
        // later thread's events unread. On the hosted app that thread sat at
        // "Thinking" while its turn completed on the control plane.
        {
          type: "thread.create",
          commandId: CommandId.make("create:opensandbox-e2e-second"),
          threadId: secondThreadId,
          projectId,
          title: "OpenSandbox end to end (second thread)",
          modelSelection: { instanceId, model: "default" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        },
        {
          type: "message.dispatch",
          commandId: CommandId.make("dispatch:opensandbox-e2e-second"),
          threadId: secondThreadId,
          messageId: MessageId.make("message:opensandbox-e2e-second"),
          text: "hello from the second thread",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        },
      ];
      // Steps, not `commands`: when a scenario lists steps the harness runs the
      // commands inside them and ignores the `commands` field entirely.
      const scenario = {
        name: "opensandbox-e2e",
        commands,
        steps: [
          { type: "dispatch" as const, command: commands[0]!, await: true },
          { type: "dispatch" as const, command: commands[1]!, await: true },
          { type: "await_thread_idle" as const, threadId },
          { type: "dispatch" as const, command: commands[2]!, await: true },
          { type: "await_thread_idle" as const, threadId },
          { type: "dispatch" as const, command: commands[3]!, await: true },
          { type: "dispatch" as const, command: commands[4]!, await: true },
        ],
        projectionThreadIds: [threadId, secondThreadId],
      };

      const result = yield* runOrchestratorV2Scenario(scenario, {
        afterSteps: Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          for (let attempt = 0; attempt < 90; attempt++) {
            const projection = yield* orchestrator.getThreadProjection(threadId);
            const second = yield* orchestrator.getThreadProjection(secondThreadId);
            const task = yield* Effect.promise(() =>
              client.findTaskByThread(String(threadId)).catch(() => null),
            );
            // eslint-disable-next-line no-console -- a stalled end-to-end run has to say where
            console.log(
              `[opensandbox-e2e] ${attempt} task=${task?.taskId ?? "none"} state=${task?.state ?? "-"} ` +
                `runs=${JSON.stringify(projection.runs.map((run) => ({ s: run.status, f: run.failure ?? null })))} ` +
                `sessions=${JSON.stringify(projection.providerSessions.map((session) => ({ d: session.driver, s: session.status })))} ` +
                `turns=${projection.providerTurns.length} messages=${projection.messages.length} ` +
                `requests=${JSON.stringify(projection.runtimeRequests.map((request) => request.status))} ` +
                `secondMessages=${second.messages.length}`,
            );
            // Two turns in the first thread (two user messages and two replies)
            // and one in the second.
            if (projection.messages.length >= 4 && second.messages.length >= 2) break;
            yield* Effect.sleep(Duration.seconds(1));
          }

          // Suspend the task the way the idle policy does, then dispatch one
          // more message into the same thread. The adapter has to resume the
          // task and wait for its worker before the turn starts: the control
          // plane refuses a message to a suspended task (`task does not accept
          // messages`), and the resume it issues is an effect that answers
          // before the worker is back. Found on the hosted app — the run failed
          // in the UI while the sandbox was resumed underneath it.
          const beforeSuspend = yield* Effect.promise(() =>
            client.findTaskByThread(String(threadId)).catch(() => null),
          );
          assert.ok(beforeSuspend, "the thread has a task to suspend");
          yield* Effect.promise(async () => {
            server.tasks.stop(beforeSuspend!.taskId);
            await server.effectWorker.drain();
          });
          const suspended = yield* Effect.promise(() => client.task(beforeSuspend!.taskId));
          assert.equal(suspended.state, "suspended", "the idle stop suspended the task");

          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("dispatch:opensandbox-e2e-3"),
            threadId,
            messageId: MessageId.make("message:opensandbox-e2e-3"),
            text: "hello after an idle stop",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });

          for (let attempt = 0; attempt < 90; attempt++) {
            const projection = yield* orchestrator.getThreadProjection(threadId);
            if (projection.messages.length >= 6) break;
            yield* Effect.sleep(Duration.seconds(1));
          }
          const afterResume = yield* Effect.promise(() => client.task(beforeSuspend!.taskId));
          assert.equal(afterResume.state, "ready", "the message resumed the task");
          assert.equal(
            afterResume.sandboxId,
            beforeSuspend!.sandboxId,
            "the resume reuses the sandbox instead of rebuilding it",
          );
        }),
      }).pipe(
        Effect.provide(layerWithRegistry(scenario, registryLayer, { runEffectWorker: true })),
        Effect.provide(TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer))),
      );

      // What T3's own projection holds after the turn: the user's message, and
      // the agent's reply, which only exists if the whole path worked — the
      // orchestrator asked the adapter, the adapter asked the control plane,
      // the control plane started a worker, the worker ran the agent, and the
      // events came back through the ingestor.
      const projection = result.projections.get(threadId);
      assert.ok(projection, "the thread has a projection");
      const text = JSON.stringify(projection.messages);
      assert.match(text, /hello from T3/, "the user's message is in the projection");
      assert.match(
        text,
        /echo\[full-access\]: hello from T3/,
        "the agent's reply is in the projection, under the mode the thread asked for",
      );

      // The sandbox really ran the turn: the provider thread T3 recorded came
      // from the worker, not from the adapter's own bookkeeping.
      assert.equal(projection.providerThreads.length, 1);
      assert.match(
        String(projection.providerThreads[0]?.nativeThreadRef?.nativeId ?? ""),
        /^echo_/,
        "the provider thread T3 recorded carries the worker's native id",
      );

      // The web UI renders the transcript from turn items, not from messages:
      // a reply that arrives only as a message reaches the projection and stays
      // invisible on screen. Found by hosting the app, not by this test.
      const items = JSON.stringify([...projection.turnItems.values()]);
      assert.match(items, /"type":"assistant_message"/, "the reply is a transcript item");
      assert.match(items, /echo\[full-access\]: hello from T3/);

      // The second turn in the same thread: the session was already bound, so
      // nothing new is created — the sandbox the first turn started is reused,
      // and the reply has to reach the projection all the same. This is the
      // case a fresh thread never exercises.
      assert.match(
        text,
        /echo\[full-access\]: hello again from T3/,
        "the second turn's reply is in the projection",
      );
      assert.match(items, /echo\[full-access\]: hello again from T3/);
      assert.equal(
        projection.providerThreads.length,
        1,
        "the second turn reused the thread the first one bound",
      );
      const failedRuns = projection.runs.filter((run) => (run.failure ?? null) !== null);
      assert.deepEqual(
        failedRuns.map((run) => run.failure),
        [],
        "neither turn failed",
      );

      // The turn dispatched into a *suspended* task: it only exists if the
      // adapter resumed the task and waited for its worker before starting it.
      assert.match(
        text,
        /echo\[full-access\]: hello after an idle stop/,
        "the reply after an idle stop is in the projection",
      );
      assert.match(items, /echo\[full-access\]: hello after an idle stop/);
      assert.equal(
        projection.providerThreads.length,
        1,
        "the resumed turn reused the thread the earlier turns bound",
      );

      // The second thread, on the same shared provider session: its reply only
      // exists if the adapter read that task's own event stream.
      const secondProjection = result.projections.get(secondThreadId);
      assert.ok(secondProjection, "the second thread has a projection");
      const secondText = JSON.stringify(secondProjection.messages);
      assert.match(secondText, /hello from the second thread/, "its message is there");
      assert.match(
        secondText,
        /echo\[full-access\]: hello from the second thread/,
        "the second thread's reply is in the projection",
      );
      const secondItems = JSON.stringify([...secondProjection.turnItems.values()]);
      assert.match(secondItems, /echo\[full-access\]: hello from the second thread/);
    }),
  180_000,
);
