import { describe, it, expect } from "vitest";
import { hexToBytes, verifySignature } from "../../functions/lib/signature";

// RFC 4231 test case 1: key = 20 bytes of 0x0b, data = "Hi There".
const SECRET_HEX = "0b".repeat(20);
const BODY = "Hi There";
const SIGNATURE =
  "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7";

// The same secret, hashed with the 40 ASCII characters "0b0b…" as the key
// instead of the 20 bytes they spell. This is what the implementation produces
// if it forgets to decode the hex, and it must not verify.
const ASCII_KEY_SIGNATURE =
  "0dff03eeb5bca6b9fd6b52d08cfc8ac04e169a3d0233fbff72b5b844fba0f96b";

describe("verifySignature", () => {
  it("verifies the known vector", async () => {
    expect(await verifySignature(SECRET_HEX, SIGNATURE, BODY)).toBe(true);
  });

  it("does not verify a signature keyed on the secret's ASCII text", async () => {
    expect(ASCII_KEY_SIGNATURE).not.toBe(SIGNATURE);
    expect(await verifySignature(SECRET_HEX, ASCII_KEY_SIGNATURE, BODY)).toBe(
      false,
    );
  });

  it("fails on a tampered body", async () => {
    expect(await verifySignature(SECRET_HEX, SIGNATURE, "Hi there")).toBe(false);
    expect(await verifySignature(SECRET_HEX, SIGNATURE, `${BODY} `)).toBe(false);
  });

  it("fails on a tampered signature", async () => {
    const flipped = `c${SIGNATURE.slice(1)}`;

    expect(await verifySignature(SECRET_HEX, flipped, BODY)).toBe(false);
  });

  it("fails on a malformed secret or signature instead of throwing", async () => {
    expect(await verifySignature("nothex", SIGNATURE, BODY)).toBe(false);
    expect(await verifySignature(SECRET_HEX, "abc", BODY)).toBe(false);
    expect(await verifySignature("", SIGNATURE, BODY)).toBe(false);
  });
});

describe("hexToBytes", () => {
  it("decodes hex to bytes", () => {
    expect(Array.from(hexToBytes("000b10ff")!)).toEqual([0, 11, 16, 255]);
  });

  it("rejects an odd-length string", () => {
    expect(hexToBytes("0b0")).toBeNull();
  });

  it("rejects a non-hex character", () => {
    // parseInt would yield NaN here and silently write a zero byte.
    expect(hexToBytes("0bzz")).toBeNull();
    expect(hexToBytes("0b 0b")).toBeNull();
  });

  it("rejects an empty string", () => {
    expect(hexToBytes("")).toBeNull();
  });
});
