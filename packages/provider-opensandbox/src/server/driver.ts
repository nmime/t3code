/**
 * The two drivers T3 loads for `driver: "opensandbox"`.
 *
 *  - `OpenSandboxAdapterV2Driver` is the orchestration-v2 half: the adapter the
 *    orchestration runtime talks to, which proxies a thread into a sandbox.
 *  - `OpenSandboxDriver` is the provider-instance (v1) half: what
 *    `ProviderInstanceRegistry` materializes from a `ServerSettings.providerInstances`
 *    entry, wrapping that adapter with the snapshot, continuation identity and
 *    text generation T3 expects of a provider. `apps/server`'s
 *    `BUILT_IN_DRIVERS` lists it — that is what makes a `"driver": "opensandbox"`
 *    entry resolve to a live instance instead of an unavailable shadow.
 *
 * `ProviderDriverKind` is an open slug, so a fork adds a driver without
 * touching the contracts layer.
 *
 * @module provider-opensandbox/server/driver
 */
import {
  ProviderDriverKind,
  TextGenerationError,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { ProviderAdapterDriver } from "@t3tools/provider-core/server/adapterDriver";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import {
  decodeJsonReply,
  fromRunner,
  withoutInvestigation,
  type Runner,
} from "@t3tools/provider-core/server/textGenerationOperations";

import { OpenSandboxSettings } from "../settings.ts";
import { makeAdapter, threadForWorkspace } from "./adapter.ts";
import {
  defaultConfig,
  normalizeControlPlaneUrl,
  type OpenSandboxProviderConfig,
} from "./config.ts";
import { OpenSandboxControlPlane, OpenSandboxControlPlaneError } from "./controlPlane.ts";

export const OPENSANDBOX_DRIVER = ProviderDriverKind.make("opensandbox");

/**
 * The driver needs no services beyond what T3 already provides: it talks to the
 * control plane over HTTP, not to the local machine.
 */
export type OpenSandboxAdapterV2DriverEnv = never;

export const OpenSandboxAdapterV2Driver: ProviderAdapterDriver<OpenSandboxProviderConfig> = {
  driverKind: OPENSANDBOX_DRIVER,
  configSchema: OpenSandboxSettings,
  defaultConfig,
  create: (input) =>
    Effect.succeed(
      makeAdapter({
        instanceId: input.instanceId,
        config: input.config,
      }),
    ),
};

/**
 * Text generation runs in the sandbox: the prompt T3 builds is handed to the
 * agent there, one-shot, and its reply is decoded against the operation's own
 * schema. That is the only place the agent exists, and the only place the
 * checkout a prompt may need to read is.
 *
 * The one operation that needs read-only tools — the review guide, which
 * investigates a checkout over as many turns as it needs — is refused rather
 * than answered blind: a one-shot invocation has no read-only tool mode to
 * promise, and `withoutInvestigation` says exactly that.
 */
/**
 * Exported for the test that pins the thread into a generation request; the
 * driver itself is the only production caller.
 */
export const makeSandboxTextGeneration = (
  client: OpenSandboxControlPlane,
): ProviderTextGeneration => {
  const run: Runner = (request) =>
    Effect.gen(function* () {
      // Name the thread when the app's checkout is one a session has claimed:
      // the control plane resolves the task by thread, because the path in the
      // request is the host copy of the project, which no task owns.
      const threadId = request.threadId ?? threadForWorkspace(request.cwd);
      const text = yield* Effect.tryPromise({
        try: () =>
          client.generateText({
            cwd: request.cwd,
            ...(threadId ? { threadId } : {}),
            prompt: request.prompt,
            ...(request.modelSelection.model ? { model: request.modelSelection.model } : {}),
          }),
        catch: (cause) =>
          new TextGenerationError({
            operation: request.operation,
            detail: "The sandbox could not answer the generation prompt.",
            cause: cause instanceof Error ? cause : new Error(String(cause)),
          }),
      });
      return yield* decodeJsonReply(request, "OpenSandbox", text);
    });
  return fromRunner("OpenSandbox", withoutInvestigation("OpenSandbox", run));
};

const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: OPENSANDBOX_DRIVER,
  packageName: null,
});

/** What the composer offers before a sandbox has reported models of its own. */
const DEFAULT_MODEL: ServerProviderModel = {
  slug: "default",
  name: "Default",
  isCustom: false,
  isDefault: true,
  capabilities: null,
};

/**
 * An instance's health is the control plane's: reachable, the token accepted,
 * and the environment profile this instance names actually there. Saying which
 * of the three failed is the difference between a usable error and
 * "unavailable".
 */
const probeInstance = (config: OpenSandboxSettings): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const base = {
      enabled: config.enabled,
      installed: true,
      version: null,
      models: [DEFAULT_MODEL],
      slashCommands: [],
      skills: [],
      checkedAt,
    };
    if (!config.enabled) {
      return {
        ...base,
        status: "disabled",
        auth: { status: "unknown" },
        message: "This instance is turned off.",
      };
    }

    const client = new OpenSandboxControlPlane({
      url: normalizeControlPlaneUrl(config.controlPlaneUrl),
      ...(config.apiToken ? { token: config.apiToken } : {}),
    });
    const probed = yield* Effect.result(
      Effect.tryPromise({
        try: () => client.listProfiles(),
        catch: (cause) => cause,
      }),
    );
    if (probed._tag === "Failure") {
      const refused =
        probed.failure instanceof OpenSandboxControlPlaneError && probed.failure.status === 401;
      return {
        ...base,
        status: "error",
        auth: { status: refused ? "unauthenticated" : "unknown" },
        message: refused
          ? `The control plane at ${client.origin} refused this token.`
          : `Could not reach the control plane at ${client.origin}.`,
      };
    }

    // A token that was sent and accepted is the only thing that earns
    // "authenticated"; a control plane that needs no token proves nothing.
    const auth = { status: config.apiToken ? "authenticated" : "unknown" } as const;
    const profile = probed.success.find((candidate) => candidate.profileId === config.profileId);
    if (profile === undefined) {
      return {
        ...base,
        status: "error",
        auth,
        message: `The control plane at ${client.origin} has no environment profile '${config.profileId}'.`,
      };
    }

    return {
      ...base,
      status: "ready",
      auth,
      message: `${client.origin} · profile ${profile.profileId} v${profile.version} · ${
        config.repositoryUrl ?? "no repository"
      }`,
    };
  });

export type OpenSandboxDriverEnv = ProviderHost.ProviderHost;

/**
 * The provider-instance half.
 *
 * `hasDefaultInstance: false` on purpose: an instance means nothing until it
 * has a control-plane URL, so nothing is auto-created — the user adds one from
 * Settings, and until then no thread routes to it.
 */
export const OpenSandboxDriver: ProviderDriver<OpenSandboxSettings, OpenSandboxDriverEnv> = {
  driverKind: OPENSANDBOX_DRIVER,
  metadata: {
    displayName: "OpenSandbox",
    supportsMultipleInstances: true,
    hasDefaultInstance: false,
  },
  configSchema: OpenSandboxSettings,
  defaultConfig,
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: OPENSANDBOX_DRIVER,
        instanceId,
      });
      const effectiveConfig = { ...config, enabled } satisfies OpenSandboxSettings;
      const orchestrationAdapter = yield* OpenSandboxAdapterV2Driver.create({
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config: effectiveConfig,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: OPENSANDBOX_DRIVER,
              instanceId,
              detail: "Failed to build the OpenSandbox orchestration adapter.",
              cause,
            }),
        ),
      );
      const checkProvider = probeInstance(effectiveConfig).pipe(
        Effect.map((draft): ServerProvider => ({
          ...draft,
          instanceId,
          driver: OPENSANDBOX_DRIVER,
          ...(displayName ? { displayName } : {}),
          ...(accentColor ? { accentColor } : {}),
          continuation: { groupKey: continuationIdentity.continuationKey },
        })),
      );
      const textGeneration = makeSandboxTextGeneration(
        new OpenSandboxControlPlane({
          url: normalizeControlPlaneUrl(effectiveConfig.controlPlaneUrl),
          ...(effectiveConfig.apiToken ? { token: effectiveConfig.apiToken } : {}),
        }),
      );
      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<OpenSandboxSettings>
      >({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: () => checkProvider,
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: OPENSANDBOX_DRIVER,
              instanceId,
              detail: "Failed to build the OpenSandbox provider snapshot.",
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: OPENSANDBOX_DRIVER,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        orchestrationAdapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
