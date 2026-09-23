/**
 * Printful returns `secret_key` as a hexadecimal string that must be decoded to
 * raw bytes before it is used as the HMAC key — signing the hex text itself
 * fails every time. Reject the whole string unless it is strictly even-length
 * hex: a per-character `parseInt` yields NaN on a stray character and silently
 * writes a zero byte, which produces a key that looks fine and never verifies.
 */
export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }

  const bytes = new Uint8Array(hex.length / 2);

  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  return bytes;
}

/**
 * Verifies `x-pf-webhook-signature` (hex) against the raw request body. The
 * body must be the untouched text — re-stringifying the parsed JSON does not
 * byte-match what Printful signed.
 */
export async function verifySignature(
  secretHex: string,
  signatureHex: string,
  rawBody: string,
): Promise<boolean> {
  const secret = hexToBytes(secretHex);
  const signature = hexToBytes(signatureHex);

  if (!secret || !signature) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  // subtle.verify compares in constant time.
  return crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    new TextEncoder().encode(rawBody),
  );
}
