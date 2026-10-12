/**
 * Daytona's client definition: settings form and label. Browser- and React
 * Native-safe — plain data and an Effect schema, no platform UI imports.
 *
 * @module provider-daytona/client
 */
import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { DaytonaSettings } from "./settings.ts";

export const daytonaClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("daytona"),
  label: "Daytona",
  settingsSchema: DaytonaSettings,
});
