import { describe, it, expect } from "vitest";
import { canFulfillLive, isLiveEnv } from "../../functions/lib/env";
import type { PrintfulSettings } from "../../functions/lib/settings";

// Exactly 32 alphanumerics — the live key shape.
const SUFFIX = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6";

const LIVE_KEY = `app_pk_${SUFFIX}`;
const TEST_KEY = `app_pk_test_${SUFFIX}`;
const STAGING_KEY = `app_pk_staging_${SUFFIX}`;

/** isLiveEnv reads `publicKey`; canFulfillLive also reads `isLocalDev`. */
function req(publicKey?: string | null, isLocalDev = false): SwellRequest {
  return { publicKey, isLocalDev } as SwellRequest;
}

function settings(live_fulfillment?: boolean): PrintfulSettings {
  return { live_fulfillment };
}

describe("isLiveEnv", () => {
  it("accepts app_pk_ followed by exactly 32 alphanumerics", () => {
    expect(SUFFIX).toHaveLength(32);
    expect(isLiveEnv(req(LIVE_KEY))).toBe(true);
  });

  // Every case below must be false. A false positive here is a real, charged
  // Printful order confirmed from a non-live environment.
  it("rejects a test key", () => {
    expect(isLiveEnv(req(TEST_KEY))).toBe(false);
  });

  it("rejects a custom environment key", () => {
    expect(isLiveEnv(req(STAGING_KEY))).toBe(false);
  });

  it("rejects a missing key", () => {
    expect(isLiveEnv(req(undefined))).toBe(false);
    expect(isLiveEnv(req(null))).toBe(false);
  });

  it("rejects an empty key", () => {
    expect(isLiveEnv(req(""))).toBe(false);
  });

  it("rejects a 31-character suffix", () => {
    expect(isLiveEnv(req(`app_pk_${SUFFIX.slice(0, 31)}`))).toBe(false);
  });

  it("rejects a 33-character suffix", () => {
    expect(isLiveEnv(req(`app_pk_${SUFFIX}x`))).toBe(false);
  });

  it("rejects a 32-character suffix containing a non-alphanumeric", () => {
    expect(isLiveEnv(req(`app_pk_${SUFFIX.slice(0, 31)}-`))).toBe(false);
    expect(isLiveEnv(req(`app_pk_${SUFFIX.slice(0, 31)}_`))).toBe(false);
  });
});

describe("canFulfillLive", () => {
  it("is true only when live env, live_fulfillment and not local dev all hold", () => {
    expect(canFulfillLive(req(LIVE_KEY, false), settings(true))).toBe(true);
  });

  it("is false under local dev", () => {
    expect(canFulfillLive(req(LIVE_KEY, true), settings(true))).toBe(false);
  });

  it("is false when live_fulfillment is unset", () => {
    expect(canFulfillLive(req(LIVE_KEY, false), settings(undefined))).toBe(
      false,
    );
  });

  it("is false when live_fulfillment is off", () => {
    expect(canFulfillLive(req(LIVE_KEY, false), settings(false))).toBe(false);
  });

  it("is false outside the live environment even with live_fulfillment on", () => {
    expect(canFulfillLive(req(TEST_KEY, false), settings(true))).toBe(false);
    expect(canFulfillLive(req(undefined, false), settings(true))).toBe(false);
  });
});
