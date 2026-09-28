import Printful from "./lib/printful";
import { getSettings, putSettings, PrintfulSettings } from "./lib/settings";
import { runProductSync } from "./lib/products";

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
];

export const config: SwellConfig = {
  description:
    "Run the Printful product sync now, or register the Printful webhook",
  route: {
    methods: ["post"],
    public: false,
  },
};

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

  const result = await printful.createWebhook({
    default_url: url,
    events: WEBHOOK_EVENTS.map((type) => ({ type })),
  });

  await putSettings(req, {
    webhook_secret: result?.secret_key,
    webhook_public_key: result?.public_key,
  });

  return {
    url,
    events: WEBHOOK_EVENTS,
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

  return runProductSync(req, settings, {
    budget: Number.isFinite(budget) && budget > 0 ? budget : undefined,
  });
}
