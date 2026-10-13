/**
 * A provider that runs an app thread's agent inside a OpenSandbox task sandbox,
 * through a `@t3tools/t3x` control plane.
 *
 * Two entry points, because T3 has two layers:
 *
 *  - `OpenSandboxDriver` is what the **server** registers. It goes in
 *    `apps/server/src/provider/builtInDrivers.ts` (`BUILT_IN_DRIVERS`), which
 *    is the list `ProviderInstanceRegistry` reads when it resolves a
 *    `ServerSettings.providerInstances` entry. Without it, a `"driver":
 *    "opensandbox"` entry surfaces as an unavailable shadow snapshot and no thread
 *    can route to it.
 *  - `OpenSandboxAdapterV2Driver` is the orchestration-v2 adapter the server's own
 *    replay tests and fixture recorders build directly, and it is listed
 *    alongside the other v2 adapter drivers in
 *    `apps/server/src/orchestration-v2/builtInProviderAdapterDrivers.ts`.
 *
 * The browser half is `@t3tools/provider-opensandbox/client` (settings form), and
 * `@t3tools/provider-opensandbox/settings` holds the schema both halves share.
 *
 * @module provider-opensandbox/server
 */
export {
  OPENSANDBOX_DRIVER,
  OpenSandboxDriver,
  OpenSandboxAdapterV2Driver,
  type OpenSandboxAdapterV2DriverEnv,
  type OpenSandboxDriverEnv,
} from "./server/driver.ts";
export { makeAdapter, OPENSANDBOX_DRIVER_KIND } from "./server/adapter.ts";
export {
  OpenSandboxSettings,
  OpenSandboxSandboxScope,
  OPENSANDBOX_SANDBOX_SCOPES,
  type OpenSandboxSettings as OpenSandboxSettingsType,
} from "./settings.ts";
export {
  decodeOpenSandboxSettings,
  defaultConfig,
  normalizeControlPlaneUrl,
  type OpenSandboxProviderConfig,
} from "./server/config.ts";
export {
  OpenSandboxControlPlane,
  OpenSandboxControlPlaneError,
  type OpenSandboxEvent,
  type OpenSandboxProfile,
  type OpenSandboxSnapshot,
  type OpenSandboxTask,
} from "./server/controlPlane.ts";
export {
  capabilitiesFromWorker,
  workerCapabilitiesForAgent,
  type WorkerCapabilities,
} from "./server/capabilities.ts";
