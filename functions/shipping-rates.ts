import Printful, { getRateLimitRemaining, rateLimitKey } from "./lib/printful";
import { getSettings, PrintfulSettings } from "./lib/settings";
import { getVariantLinks, toRateItems, toRecipient } from "./lib/mapping";
import {
  FALLBACK_SERVICE_ID,
  isPrintfulService,
  quoteCacheKey,
  readQuote,
  ShippingService,
  toShippingServices,
  writeQuote,
} from "./lib/rates";

const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_CACHE_TTL = 300;

// Below this many requests left in the current window, serve the fallback
// rather than risk a 429 and the 60s lockout that follows it.
const RATE_LIMIT_FLOOR = 10;

export const config: SwellConfig = {
  extension: "printful",
  description: "Quote live Printful shipping rates for print-on-demand items",
  model: {
    events: ["after:order.shipping"],
    fields: ["shipment_rating"],
  },
};

function fallbackServices(settings: PrintfulSettings): ShippingService[] {
  if (settings.fallback_rate == null) {
    return [];
  }

  return [
    {
      id: FALLBACK_SERVICE_ID,
      name: settings.fallback_service_name || "Standard shipping",
      price: settings.fallback_rate,
      carrier: "printful",
    },
  ];
}

export default async function (req: SwellRequest) {
  // The configured timeout is the budget for the whole invocation, not just the
  // Printful call: the settings and link reads below spend part of it, and
  // the platform kills the function at 10s whether or not the fallback has been
  // returned. Measuring from here keeps the abort ahead of that kill.
  const startedAt = Date.now();

  // req.data is the partial write payload, not the whole order — items and
  // shipping are only present when they were part of this write.
  const record = req.data.$record ?? {};
  const items = req.data.items ?? record.items;
  const shipping = req.data.shipping ?? record.shipping;
  const currency = req.data.currency ?? record.currency;

  const existing: ShippingService[] =
    req.data.shipment_rating?.services ?? record.shipment_rating?.services ?? [];

  // Preserve every service this app did not produce: an after: hook merges
  // into the platform's rating and must not drop native carriers.
  const preserved = existing.filter((service) => !isPrintfulService(service.id));

  if (!shipping?.country || !items?.length) {
    return;
  }

  let settings: PrintfulSettings;

  try {
    settings = await getSettings(req, { $currency: currency });
  } catch {
    return;
  }

  if (!settings.api_token) {
    return;
  }

  try {
    const links = await getVariantLinks(req, items);
    const rateItems = toRateItems(items, links);

    if (rateItems.length === 0) {
      return;
    }

    const recipient = toRecipient(shipping);
    const key = quoteCacheKey(
      req.storeId || req.store.id,
      recipient,
      currency,
      rateItems,
    );

    const cached = readQuote(key, settings.quote_cache_ttl ?? DEFAULT_CACHE_TTL);
    if (cached) {
      return { shipment_rating: { services: [...preserved, ...cached] } };
    }

    const remaining = getRateLimitRemaining(rateLimitKey(settings.api_token));
    if (remaining !== null && remaining < RATE_LIMIT_FLOOR) {
      return rated(preserved, fallbackServices(settings), {
        code: "rate_limited",
        message: "Printful rate limit nearly exhausted, using the fallback rate",
      });
    }

    const remainingMs =
      startedAt + (settings.rate_timeout_ms ?? DEFAULT_TIMEOUT_MS) - Date.now();

    if (remainingMs <= 0) {
      return rated(preserved, fallbackServices(settings), {
        code: "timeout",
        message: "Ran out of time before Printful could be asked for a rate",
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remainingMs);

    try {
      const printful = new Printful(
        settings.api_token,
        settings.store_id,
        controller.signal,
      );

      const response = await printful.getShippingRates({
        recipient,
        order_items: rateItems,
        currency,
      });

      const services = toShippingServices(response?.data ?? []);

      if (services.length === 0) {
        return rated(preserved, fallbackServices(settings), {
          code: "no_rates",
          message: "Printful returned no shipping rates for this destination",
        });
      }

      writeQuote(key, services);

      return { shipment_rating: { services: [...preserved, ...services] } };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // An after: hook cannot reject the write and gets no retries, so a failed
    // quote must degrade to the configured flat rate rather than throw.
    return rated(preserved, fallbackServices(settings), {
      code: "printful_error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function rated(
  preserved: ShippingService[],
  fallback: ShippingService[],
  error: { code: string; message: string },
) {
  return {
    shipment_rating: {
      services: [...preserved, ...fallback],
      errors: [error],
    },
  };
}
