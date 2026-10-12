/**
 * The driver T3's provider-instance registry loads for `driver: "daytona"`.
 *
 * `ProviderDriverKind` is an open slug, so a fork can add a driver without
 * touching the contracts layer; this is that driver for a Daytona control plane.
 */
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProviderAdapterDriver } from "@t3tools/provider-core/server/adapterDriver";

import { makeAdapter } from "./adapter.ts";
import { DaytonaProviderConfig, defaultConfig } from "./config.ts";

export const DAYTONA_DRIVER = ProviderDriverKind.make("daytona");

/**
 * The driver needs no services beyond what T3 already provides: it talks to the
 * control plane over HTTP, not to the local machine.
 */
export type DaytonaAdapterV2DriverEnv = never;

export const DaytonaAdapterV2Driver: ProviderAdapterDriver<DaytonaProviderConfig> = {
  driverKind: DAYTONA_DRIVER,
  configSchema: DaytonaProviderConfig,
  defaultConfig,
  create: (input) =>
    Effect.succeed(
      makeAdapter({
        instanceId: input.instanceId,
        config: input.config,
      }),
    ),
};
