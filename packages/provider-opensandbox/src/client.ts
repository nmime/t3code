/**
 * OpenSandbox's client definition: settings form and label. Browser- and React
 * Native-safe — plain data and an Effect schema, no platform UI imports.
 *
 * @module provider-opensandbox/client
 */
import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { OpenSandboxSettings } from "./settings.ts";

export const openSandboxClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("opensandbox"),
  label: "OpenSandbox",
  settingsSchema: OpenSandboxSettings,
});
