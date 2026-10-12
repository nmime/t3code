/**
 * Server-side view of an instance's settings.
 *
 * The schema itself lives in `../settings.ts`, because the browser settings
 * form shares it. This module holds what only the server needs: the URL
 * normalisation and the defaults for an instance nobody has configured yet.
 *
 * @module provider-daytona/server/config
 */
import * as Schema from "effect/Schema";

import { DaytonaSettings } from "../settings.ts";

/** Config for an instance that runs its agent inside a Daytona task sandbox. */
export type DaytonaProviderConfig = DaytonaSettings;

export const decodeDaytonaSettings = Schema.decodeSync(DaytonaSettings);

export const defaultConfig = (): DaytonaProviderConfig => decodeDaytonaSettings({});

/** The control plane is always reachable over HTTP(S); reject anything else. */
export const normalizeControlPlaneUrl = (raw: string): string => {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(trimmed)) return `http://${trimmed}`;
  return trimmed;
};
