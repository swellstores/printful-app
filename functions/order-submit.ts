import { getSettings } from "./lib/settings";
import { getCatalogItems, toRateItems } from "./lib/mapping";
import { isUniqueViolation } from "./lib/errors";

export const config: SwellConfig = {
  description: "Claim a paid order for Printful fulfillment",
  model: {
    events: ["order.paid"],
  },
};

export default async function (req: SwellRequest) {
  const order = req.data;
  const settings = await getSettings(req);

  if (!settings.api_token) {
    return;
  }

  const catalog = await getCatalogItems(req, order.items ?? []);

  if (toRateItems(order.items ?? [], catalog).length === 0) {
    return;
  }

  try {
    // Creating the claim is the whole job, and it is done before any Printful
    // I/O so that all of that I/O happens later, in fulfillment-advance.
    //
    // `unique: true` on order_id is not a database index. The server checks it
    // by reading for a matching row and rejecting if one comes back, so two
    // inserts racing inside that read-then-write window can both find nothing
    // and both insert. Duplicate order.paid deliveries arrive seconds to
    // minutes apart, not microseconds, so in practice this collapses them —
    // but it is a best-effort check, not a mutex.
    //
    // Printful has no idempotency key, so the durable guarantee against one
    // order becoming two would have to be Printful rejecting a second
    // POST /v2/orders carrying an external_id it already holds. Whether it does
    // is unverified — OPEN-QUESTIONS.md item 1.
    await req.swell.post(`/apps/${req.appId}/fulfillments`, {
      order_id: order.id,
      external_id: order.id,
      state: "pending",
      attempts: 0,
      date_next_attempt: new Date().toISOString(),
    });
  } catch (err) {
    if (isUniqueViolation(err, "order_id")) {
      return;
    }
    throw err;
  }

  await req.swell.put(
    `/orders/${order.id}`,
    req.appValues({ submit_state: "pending" }),
  );
}
