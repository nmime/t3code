/**
 * OpenSandbox instance settings. Shared by the server driver and the client
 * settings form, so it holds only browser-safe schema code.
 *
 * A provider instance is a *route to a sandbox*: the control plane owns the
 * sandbox, the repository, the environment profile and the agent process, and
 * T3 talks to it as a provider. One instance can therefore serve many threads,
 * each in its own sandbox or in its project's shared one.
 *
 * @module provider-opensandbox/settings
 */
import {
  makeProviderSettingsSchema,
  secretSetting,
  TrimmedString,
  type ProviderSettingsFormOption,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** How a task picks its sandbox. Mirrors the control plane's `sandboxScope`. */
export const OPENSANDBOX_SANDBOX_SCOPES = [
  { value: "project", label: "Share the project's sandbox (a worktree per thread)" },
  { value: "task", label: "Give every thread its own sandbox" },
] as const satisfies ReadonlyArray<ProviderSettingsFormOption>;

export const OpenSandboxSandboxScope = Schema.Literals(
  OPENSANDBOX_SANDBOX_SCOPES.map((scope) => scope.value),
);

export const OpenSandboxSettings = makeProviderSettingsSchema(
  {
    // Off by default like Cursor, Grok and Pi. Users opt in from Settings.
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    controlPlaneUrl: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("http://127.0.0.1:8087")),
      Schema.annotateKey({
        title: "Control plane URL",
        description:
          "Base URL of the t3x control plane that owns the sandboxes. T3 reaches it over HTTP(S); the sandboxes themselves are never dialled from here.",
        providerSettingsForm: {
          placeholder: "https://t3x.example.com",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    apiToken: TrimmedString.pipe(
      secretSetting,
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "API token",
        description:
          "Bearer token the control plane requires, when it requires one. Stored in the server's secret store, never sent to a sandbox or an agent.",
        providerSettingsForm: { control: "password", clearWhenEmpty: "omit" },
      }),
    ),
    profileId: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("typescript-backend")),
      Schema.annotateKey({
        title: "Environment profile",
        description:
          "Profile the sandbox is provisioned from, under the name the control plane knows it by.",
        providerSettingsForm: { placeholder: "typescript-backend", clearWhenEmpty: "omit" },
      }),
    ),
    repositoryUrl: Schema.optionalKey(TrimmedString).pipe(
      Schema.annotateKey({
        title: "Repository",
        description:
          "Repository cloned into the sandbox. Leave empty for a scratch workspace with no repository.",
        providerSettingsForm: { placeholder: "github.com/nmime/backend", clearWhenEmpty: "omit" },
      }),
    ),
    branch: Schema.optionalKey(TrimmedString).pipe(
      Schema.annotateKey({
        title: "Branch",
        description:
          "Branch checked out in the base checkout, and the base ref for per-thread worktrees.",
        providerSettingsForm: { placeholder: "main", clearWhenEmpty: "omit" },
      }),
    ),
    sandboxScope: OpenSandboxSandboxScope.pipe(
      Schema.withDecodingDefault(Effect.succeed("project" as const)),
      Schema.annotateKey({
        title: "Sandbox scope",
        description:
          "Where a thread's work runs. The control plane may still give a thread its own sandbox — when the shared one is full, or when the profile demands isolation.",
        providerSettingsForm: {
          control: "select",
          options: OPENSANDBOX_SANDBOX_SCOPES,
          clearWhenEmpty: "omit",
        },
      }),
    ),
    projectId: Schema.optionalKey(TrimmedString).pipe(
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    agent: Schema.optionalKey(TrimmedString).pipe(
      Schema.annotateKey({
        title: "Agent",
        description:
          "What the sandbox runs: codex, claude, opencode, pi or echo. Empty leaves the choice to the environment profile.",
        providerSettingsForm: { placeholder: "codex", clearWhenEmpty: "omit" },
      }),
    ),
    model: Schema.optionalKey(TrimmedString).pipe(
      Schema.annotateKey({
        title: "Default model",
        description:
          "Model passed to the agent unless the thread selects one. Empty leaves it to the agent's own default.",
        providerSettingsForm: { placeholder: "default", clearWhenEmpty: "omit" },
      }),
    ),
    pollIntervalMs: Schema.optionalKey(Schema.Number).pipe(
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    readyTimeoutMs: Schema.optionalKey(Schema.Number).pipe(
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: [
      "controlPlaneUrl",
      "apiToken",
      "profileId",
      "repositoryUrl",
      "branch",
      "sandboxScope",
      "agent",
      "model",
    ],
  },
);
export type OpenSandboxSettings = typeof OpenSandboxSettings.Type;
