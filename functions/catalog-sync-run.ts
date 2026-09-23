import Printful from "./lib/printful";
import { getSettings, putSettings, PrintfulSettings } from "./lib/settings";
import { runCatalogSync } from "./lib/catalog";

// Printful only delivers the event types named at registration, so every type
// printful-event-handle branches on has to be listed here or its branch is
// unreachable.
const WEBHOOK_EVENTS = [
  "shipment_sent",
  "shipment_delivered",
  "order_updated",
  "order_failed",
  "order_canceled",
  "order_refunded",
  "catalog_price_changed",
  "catalog_stock_updated",
];

// Catalog rows read to derive the watched product list. One row per variant, so
// this covers a few hundred products; a larger catalog watches the first page.
const MAX_CATALOG_ROWS = 1000;

export const config: SwellConfig = {
  description:
    "Run or resume the Printful catalog sync now, and register the Printful webhook",
  route: {
    methods: ["post"],
    public: false,
  },
};

/**
 * `catalog_stock_updated` is scoped at registration: it only fires for the
 * catalog products named in its params, so the synced ones are listed. Products
 * synced after this runs are not watched until the webhook is registered again.
 */
async function watchedProductIds(req: SwellRequest): Promise<number[]> {
  const result = await req.swell.get(`/apps/${req.appId}/catalog-items`, {
    limit: MAX_CATALOG_ROWS,
    fields: ["catalog_product_id"],
  });

  return [
    ...new Set(
      (result?.results ?? [])
        .map((row: any) => Number(row.catalog_product_id))
        .filter((id: number) => Number.isFinite(id) && id > 0),
    ),
  ] as number[];
}

/**
 * `POST /v2/webhooks` is a destructive singleton: one configuration exists per
 * Printful token, registering replaces whatever was there, and the secret it
 * returns is shown once. So this refuses to run over an existing registration
 * unless it is asked to explicitly.
 */
async function registerWebhook(
  req: SwellRequest,
  settings: PrintfulSettings,
  options: { url?: string; force?: boolean },
) {
  if (settings.webhook_secret && !options.force) {
    throw new SwellError(
      "A Printful webhook is already registered. Pass force:true to replace it — " +
        "the existing registration stops working and its secret is rotated.",
      { status: 409 },
    );
  }

  const url =
    options.url ||
    `${String(req.store.url).replace(/\/+$/, "")}/functions/${req.appId}/printful-webhook`;

  const printful = new Printful(
    settings.api_token as string,
    settings.store_id,
  );

  const products = await watchedProductIds(req);

  // Printful requires the product list on the stock event, so it is registered
  // only once the catalog sync has produced something to watch.
  const types = WEBHOOK_EVENTS.filter(
    (type) => type !== "catalog_stock_updated" || products.length > 0,
  );

  const result = await printful.createWebhook({
    default_url: url,
    events: types.map((type) =>
      type === "catalog_stock_updated"
        ? { type, params: [{ name: "products", value: products }] }
        : { type },
    ),
  });

  await putSettings(req, {
    webhook_secret: result?.secret_key,
    webhook_public_key: result?.public_key,
  });

  return {
    url,
    events: types,
    watched_products: products.length,
    registered: Boolean(result?.secret_key),
    note:
      "This replaced any previous Printful webhook and rotated its secret and " +
      "public key. Anything still verifying with the old secret stops working, " +
      "and registering again rotates them a second time.",
  };
}

export async function post(req: SwellRequest) {
  const settings = await getSettings(req);

  if (!settings.api_token) {
    throw new SwellError("Printful API token is not configured", {
      status: 400,
    });
  }

  if (req.data.register_webhook) {
    return registerWebhook(req, settings, {
      url: req.data.url,
      force: Boolean(req.data.force),
    });
  }

  const budget = Number(req.data.budget);

  return runCatalogSync(req, settings, {
    budget: Number.isFinite(budget) && budget > 0 ? budget : undefined,
  });
}
