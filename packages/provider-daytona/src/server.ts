/**
 * A provider that runs an app thread's agent inside a Daytona task sandbox,
 * through a `@t3tools/daytona` control plane.
 *
 * Two entry points, because T3 has two layers:
 *
 *  - `DaytonaDriver` is what the **server** registers. It goes in
 *    `apps/server/src/provider/builtInDrivers.ts` (`BUILT_IN_DRIVERS`), which
 *    is the list `ProviderInstanceRegistry` reads when it resolves a
 *    `ServerSettings.providerInstances` entry. Without it, a `"driver":
 *    "daytona"` entry surfaces as an unavailable shadow snapshot and no thread
 *    can route to it.
 *  - `DaytonaAdapterV2Driver` is the orchestration-v2 adapter the server's own
 *    replay tests and fixture recorders build directly, and it is listed
 *    alongside the other v2 adapter drivers in
 *    `apps/server/src/orchestration-v2/builtInProviderAdapterDrivers.ts`.
 *
 * The browser half is `@t3tools/provider-daytona/client` (settings form), and
 * `@t3tools/provider-daytona/settings` holds the schema both halves share.
 *
 * @module provider-daytona/server
 */
export {
  DAYTONA_DRIVER,
  DaytonaDriver,
  DaytonaAdapterV2Driver,
  type DaytonaAdapterV2DriverEnv,
  type DaytonaDriverEnv,
} from "./server/driver.ts";
export { makeAdapter, DAYTONA_DRIVER_KIND } from "./server/adapter.ts";
export {
  DaytonaSettings,
  DaytonaSandboxScope,
  DAYTONA_SANDBOX_SCOPES,
  type DaytonaSettings as DaytonaSettingsType,
} from "./settings.ts";
export {
  decodeDaytonaSettings,
  defaultConfig,
  normalizeControlPlaneUrl,
  type DaytonaProviderConfig,
} from "./server/config.ts";
export {
  DaytonaControlPlane,
  DaytonaControlPlaneError,
  type DaytonaEvent,
  type DaytonaProfile,
  type DaytonaSnapshot,
  type DaytonaTask,
} from "./server/controlPlane.ts";
export {
  capabilitiesFromWorker,
  workerCapabilitiesForAgent,
  type WorkerCapabilities,
} from "./server/capabilities.ts";
