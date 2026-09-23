import type { PrintfulSettings } from "./settings";

declare global {
  interface SwellRequest {
    /** Set by the runtime; not declared in @swell/app-types 1.2.4 yet. */
    isLocalDev: boolean;
  }
}

/**
 * App public keys are `app_pk_<env segment><32 alphanumerics>`, and the live
 * environment is the one with no environment segment at all — test keys read
 * `app_pk_test_...`, a custom environment `app_pk_staging_...`. Matching the
 * live shape exactly is a default-deny: an unrecognised or missing key is
 * never treated as live.
 */
export function isLiveEnv(req: SwellRequest): boolean {
  return /^app_pk_[A-Za-z0-9]{32}$/.test(req.publicKey ?? "");
}

/**
 * The single gate in front of anything that costs the merchant money. Creating
 * a Printful draft is free; confirming it is the charge point, so only the
 * confirmation is allowed to depend on this returning true.
 */
export function canFulfillLive(
  req: SwellRequest,
  settings: PrintfulSettings,
): boolean {
  return (
    !req.isLocalDev && isLiveEnv(req) && settings.live_fulfillment === true
  );
}
