import { getSettings } from "./lib/settings";
import { verifySignature } from "./lib/signature";
import { isUniqueViolation } from "./lib/errors";

export const config: SwellConfig = {
  description: "Receive and verify inbound Printful webhook events",
  route: {
    public: true,
    methods: ["post"],
  },
};

function unauthorized() {
  return new SwellResponse({ error: "unauthorized" }, { status: 401 });
}

/** Printful sends unix seconds on some events and ISO 8601 on others. */
function toDate(value: unknown): string | undefined {
  if (typeof value === "number") {
    return new Date(value * 1000).toISOString();
  }

  return typeof value === "string" ? value : undefined;
}

export async function post(req: SwellRequest) {
  const signature = req.headers.get("x-pf-webhook-signature");
  const settings = await getSettings(req);

  if (!signature || !settings.webhook_secret) {
    return unauthorized();
  }

  // The HMAC covers the raw body: re-stringifying the parsed JSON does not
  // byte-match what Printful signed.
  const verified = await verifySignature(
    settings.webhook_secret,
    signature,
    req.rawBody,
  );

  if (!verified) {
    return unauthorized();
  }

  const event: Record<string, any> =
    req.body && typeof req.body === "object" ? req.body : {};
  const data = event.data ?? {};

  const occurredAt = toDate(event.occurred_at ?? event.created);

  // Printful retries at 1, 4, 16, 64, 256 and 1024 minutes and sends no
  // delivery id, so the subject plus the event time is the only replay key.
  // Catalog events carry no order or shipment, and occurred_at is only
  // second-resolution, so the ids they do carry stand in as the subject —
  // without them two catalog events in the same second share a key and the
  // second is dropped as a replay. Those ids are stable across a retry, unlike
  // the envelope's own retry counter.
  const subject =
    data.shipment?.id ??
    data.order?.id ??
    data.order_id ??
    [
      ...(data.catalog_product_ids ?? []),
      ...(data.catalog_variant_ids ?? []),
    ].join(",");

  const dedupeKey = `${event.type}:${subject}:${occurredAt ?? ""}`;

  try {
    await req.swell.post(`/apps/${req.appId}/printful-events`, {
      dedupe_key: dedupeKey,
      type: event.type,
      occurred_at: occurredAt,
      store_id: event.store_id != null ? String(event.store_id) : undefined,
      retries: event.retries,
      data,
    });
  } catch (err) {
    // A replay of an event already stored is a success, not a failure.
    if (!isUniqueViolation(err, "dedupe_key")) {
      throw err;
    }
  }

  // Everything slow happens off printful-event.created. Printful amplifies a
  // slow receiver, so this returns as soon as the event is durable.
  return { received: true };
}
