import type { PrintfulRate } from "./printful";
import type { RateItem } from "./mapping";

const SERVICE_PREFIX = "printful_";

/** Offered when Printful cannot be reached. It maps to no Printful code. */
export const FALLBACK_SERVICE_ID = "printful_fallback";

const MAX_CACHED_QUOTES = 200;

export interface ShippingService {
  id: string;
  name: string;
  price: number;
  carrier: string;
  description?: string;
}

export function isPrintfulService(id?: string): boolean {
  return typeof id === "string" && id.startsWith(SERVICE_PREFIX);
}

/**
 * Recovers the Printful shipping code (e.g. `STANDARD`) from a selected Swell
 * service id, so order submission can ask for the service the customer chose.
 * Returns null for the fallback service — Printful never quoted it, so the
 * order is created without a shipping preference instead.
 */
export function toPrintfulShipping(serviceId?: string | null): string | null {
  if (!isPrintfulService(serviceId ?? undefined) || serviceId === FALLBACK_SERVICE_ID) {
    return null;
  }

  return (serviceId as string).slice(SERVICE_PREFIX.length);
}

function deliveryEstimate(rate: PrintfulRate): string | undefined {
  const min = rate.min_delivery_days;
  const max = rate.max_delivery_days;

  if (min && max) {
    return min === max
      ? `${min} business days`
      : `${min}-${max} business days`;
  }

  return max ? `Up to ${max} business days` : undefined;
}

/**
 * The rate id is the response's `shipping` field, not `id`, and `rate` arrives
 * as a string. Delivery estimates are frequently absent.
 */
export function toShippingServices(rates: PrintfulRate[]): ShippingService[] {
  const services: ShippingService[] = [];

  for (const rate of rates) {
    const price = Number.parseFloat(String(rate?.rate));

    if (!rate?.shipping || !Number.isFinite(price)) {
      continue;
    }

    services.push({
      id: `${SERVICE_PREFIX}${rate.shipping}`,
      name: (rate.shipping_method_name || rate.shipping).trim(),
      price,
      carrier: "printful",
      description: deliveryEstimate(rate),
    });
  }

  return services;
}

/**
 * `tenant` is the store the quote belongs to. One deployed script serves every
 * store with the app installed, so a key without it would let one merchant's
 * quote answer another merchant's checkout.
 */
export function quoteCacheKey(
  tenant: string,
  recipient: Record<string, any>,
  currency: string,
  items: RateItem[],
): string {
  const lines = items
    .map((item) => `${item.catalog_variant_id}x${item.quantity}`)
    .sort()
    .join(",");

  return [
    tenant,
    recipient.country_code ?? "",
    recipient.state_code ?? "",
    recipient.zip ?? "",
    currency ?? "",
    lines,
  ].join("|");
}

// Cloudflare keeps an isolate warm across the repeated order writes of a single
// checkout, so a module-scope cache absorbs most of the re-quoting that would
// otherwise burn through Printful's per-minute budget. It is per-isolate and
// best-effort by design: a cold isolate simply quotes again.
const quotes = new Map<string, { services: ShippingService[]; at: number }>();

export function readQuote(
  key: string,
  ttlSeconds: number,
): ShippingService[] | null {
  const entry = quotes.get(key);

  if (!entry || Date.now() - entry.at > ttlSeconds * 1000) {
    return null;
  }

  return entry.services;
}

export function writeQuote(key: string, services: ShippingService[]): void {
  if (quotes.size >= MAX_CACHED_QUOTES) {
    quotes.delete(quotes.keys().next().value as string);
  }

  quotes.set(key, { services, at: Date.now() });
}
