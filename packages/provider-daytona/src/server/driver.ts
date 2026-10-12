/**
 * The two drivers T3 loads for `driver: "daytona"`.
 *
 *  - `DaytonaAdapterV2Driver` is the orchestration-v2 half: the adapter the
 *    orchestration runtime talks to, which proxies a thread into a sandbox.
 *  - `DaytonaDriver` is the provider-instance (v1) half: what
 *    `ProviderInstanceRegistry` materializes from a `ServerSettings.providerInstances`
 *    entry, wrapping that adapter with the snapshot, continuation identity and
 *    text generation T3 expects of a provider. `apps/server`'s
 *    `BUILT_IN_DRIVERS` lists it — that is what makes a `"driver": "daytona"`
 *    entry resolve to a live instance instead of an unavailable shadow.
 *
 * `ProviderDriverKind` is an open slug, so a fork adds a driver without
 * touching the contracts layer.
 *
 * @module provider-daytona/server/driver
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

import { DaytonaSettings } from "../settings.ts";
import { makeAdapter } from "./adapter.ts";
import { defaultConfig, normalizeControlPlaneUrl, type DaytonaProviderConfig } from "./config.ts";
import { DaytonaControlPlane, DaytonaControlPlaneError } from "./controlPlane.ts";

export const DAYTONA_DRIVER = ProviderDriverKind.make("daytona");

/**
 * The driver needs no services beyond what T3 already provides: it talks to the
 * control plane over HTTP, not to the local machine.
 */
export type DaytonaAdapterV2DriverEnv = never;

export const DaytonaAdapterV2Driver: ProviderAdapterDriver<DaytonaProviderConfig> = {
  driverKind: DAYTONA_DRIVER,
  configSchema: DaytonaSettings,
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
 * The sandbox runs the agent, so nothing here generates application text: a
 * commit message or a thread title would have to come from a model inside the
 * sandbox, which this integration does not do yet. T3 is told the operation is
 * unsupported rather than that a model failed.
 */
const makeUnsupportedTextGeneration = (): ProviderTextGeneration => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail:
          "Daytona instances run the agent inside a sandbox and do not provide application text generation.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
    generateReviewGuide: () => unsupported("generateReviewGuide"),
  };
};

const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DAYTONA_DRIVER,
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
const probeInstance = (config: DaytonaSettings): Effect.Effect<ServerProviderDraft> =>
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

    const client = new DaytonaControlPlane({
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
        probed.failure instanceof DaytonaControlPlaneError && probed.failure.status === 401;
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

export type DaytonaDriverEnv = ProviderHost.ProviderHost;

/**
 * The provider-instance half.
 *
 * `hasDefaultInstance: false` on purpose: an instance means nothing until it
 * has a control-plane URL, so nothing is auto-created — the user adds one from
 * Settings, and until then no thread routes to it.
 */
export const DaytonaDriver: ProviderDriver<DaytonaSettings, DaytonaDriverEnv> = {
  driverKind: DAYTONA_DRIVER,
  metadata: {
    displayName: "Daytona",
    supportsMultipleInstances: true,
    hasDefaultInstance: false,
  },
  configSchema: DaytonaSettings,
  defaultConfig,
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DAYTONA_DRIVER,
        instanceId,
      });
      const effectiveConfig = { ...config, enabled } satisfies DaytonaSettings;
      const orchestrationAdapter = yield* DaytonaAdapterV2Driver.create({
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
              driver: DAYTONA_DRIVER,
              instanceId,
              detail: "Failed to build the Daytona orchestration adapter.",
              cause,
            }),
        ),
      );
      const checkProvider = probeInstance(effectiveConfig).pipe(
        Effect.map((draft): ServerProvider => ({
          ...draft,
          instanceId,
          driver: DAYTONA_DRIVER,
          ...(displayName ? { displayName } : {}),
          ...(accentColor ? { accentColor } : {}),
          continuation: { groupKey: continuationIdentity.continuationKey },
        })),
      );
      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<DaytonaSettings>>({
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
              driver: DAYTONA_DRIVER,
              instanceId,
              detail: "Failed to build the Daytona provider snapshot.",
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DAYTONA_DRIVER,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        orchestrationAdapter,
        textGeneration: makeUnsupportedTextGeneration(),
      } satisfies ProviderInstance;
    }),
};
