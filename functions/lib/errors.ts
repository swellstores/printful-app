/**
 * True when a write lost a unique index on `field`.
 *
 * The platform throws two different shapes for this. A validation failure
 * throws with the errors map itself as the body — `{order_id: {code: "UNIQUE",
 * ...}}` — while a plain non-2xx response throws with the whole response body,
 * which nests the same map under `errors`. Both reach a caller, so both are
 * unwrapped here.
 */
export function isUniqueViolation(err: unknown, field: string): boolean {
  const body = (err as SwellError)?.body;

  if (!body || typeof body !== "object") {
    return false;
  }

  const errors = (body as Record<string, any>).errors ?? body;

  return errors?.[field]?.code === "UNIQUE";
}
