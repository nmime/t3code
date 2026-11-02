/**
 * Which model a turn actually runs with.
 *
 * The picker's `default` sentinel means "no model flag": the agent then falls
 * back to whatever its own config file names. An instance that names a default
 * model means that model instead, so the sentinel is resolved here rather than
 * handed to the control plane as a literal slug.
 *
 * @module provider-opensandbox/server/modelSelection
 */

export const DEFAULT_MODEL_SLUG = "default";

export const resolveModelSelection = (
  selection: string | null | undefined,
  instanceModel: string | null | undefined,
): string => {
  const chosen = instanceModel?.trim();
  if (selection && selection !== DEFAULT_MODEL_SLUG) return selection;
  return chosen && chosen.length > 0 ? chosen : (selection ?? DEFAULT_MODEL_SLUG);
};
