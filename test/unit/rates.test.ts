import { describe, it, expect } from "vitest";
import {
  FALLBACK_SERVICE_ID,
  quoteCacheKey,
  toPrintfulShipping,
  toShippingServices,
} from "../../functions/lib/rates";
import type { PrintfulRate } from "../../functions/lib/printful";
import type { RateItem } from "../../functions/lib/mapping";

// `id` is Printful's own row id and is deliberately not the service identifier.
const RATE = {
  id: 118,
  shipping: "STANDARD",
  shipping_method_name: "Flat Rate (3-5 business days)",
  rate: "4.99",
  currency: "USD",
  min_delivery_days: 3,
  max_delivery_days: 5,
} as PrintfulRate;

describe("toShippingServices", () => {
  it("takes the service id from `shipping`, not `id`", () => {
    const [service] = toShippingServices([RATE]);

    expect(service.id).toBe("printful_STANDARD");
    expect(service.id).not.toContain("118");
  });

  it("converts a string rate to a number", () => {
    const [service] = toShippingServices([RATE]);

    expect(service.price).toBe(4.99);
    expect(typeof service.price).toBe("number");
  });

  it("maps a rate with no delivery estimate", () => {
    const bare = {
      shipping: "ECONOMY",
      rate: "3.50",
    } as PrintfulRate;

    const [service] = toShippingServices([bare]);

    expect(service).toMatchObject({
      id: "printful_ECONOMY",
      name: "ECONOMY",
      price: 3.5,
      carrier: "printful",
    });
    expect(service.description).toBeUndefined();
  });

  it("recovers the raw Printful code from the service id", () => {
    const [service] = toShippingServices([RATE]);

    // Order submission has to ask Printful for the service the customer chose.
    expect(toPrintfulShipping(service.id)).toBe(RATE.shipping);
  });

  it("has no Printful code for the fallback service", () => {
    expect(toPrintfulShipping(FALLBACK_SERVICE_ID)).toBeNull();
    expect(toPrintfulShipping("usps_priority")).toBeNull();
    expect(toPrintfulShipping(null)).toBeNull();
  });
});

describe("quoteCacheKey", () => {
  const recipient = { country_code: "US", state_code: "CA", zip: "94110" };
  const items: RateItem[] = [
    { source: "catalog", catalog_variant_id: 4012, quantity: 2 },
  ];

  it("includes the tenant", () => {
    const key = quoteCacheKey("store_a", recipient, "USD", items);

    expect(key.split("|")[0]).toBe("store_a");
  });

  it("separates two tenants with otherwise identical inputs", () => {
    // One deployed script serves every store, so a key without the tenant
    // would let one merchant's quote answer another merchant's checkout.
    const a = quoteCacheKey("store_a", recipient, "USD", items);
    const b = quoteCacheKey("store_b", recipient, "USD", items);

    expect(a).not.toBe(b);
  });
});
