/**
 * A provider driver that runs an app thread's agent inside a Daytona task
 * sandbox, through a `@t3tools/daytona` control plane.
 *
 * Register it where the other drivers are registered
 * (`apps/server/src/orchestration-v2/builtInProviderAdapterDrivers.ts`) and
 * configure a provider instance with `driver: "daytona"`.
 */
export {
  DAYTONA_DRIVER,
  DaytonaAdapterV2Driver,
  type DaytonaAdapterV2DriverEnv,
} from "./server/driver.ts";
export { makeAdapter, DAYTONA_DRIVER_KIND } from "./server/adapter.ts";
export {
  DaytonaProviderConfig,
  defaultConfig,
  normalizeControlPlaneUrl,
  type DaytonaProviderConfig as DaytonaProviderConfigType,
} from "./server/config.ts";
export {
  DaytonaControlPlane,
  DaytonaControlPlaneError,
  type DaytonaEvent,
  type DaytonaSnapshot,
  type DaytonaTask,
} from "./server/controlPlane.ts";
export {
  capabilitiesFromWorker,
  workerCapabilitiesForAgent,
  type WorkerCapabilities,
} from "./server/capabilities.ts";
