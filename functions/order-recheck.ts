import Printful from "./lib/printful";
import { getSettings } from "./lib/settings";

export const config: SwellConfig = {
  description:
    "Recheck a failed order in Printful from its page in the Swell admin, and track it again if it was fixed there",
  action: {},
};

/**
 * An order Printful marks failed is no longer checked: most never recover, and
 * checking each of them on a schedule would be load for nothing. When one is
 * fixed in Printful after all — paid for, or given new print files — this puts
 * it back under tracking, so its shipments reach the Swell order.
 */
export async function post(req: SwellRequest) {
  const settings = await getSettings(req);

  if (!settings.api_token) {
    throw new SwellError(
      "Add your Printful API token in the app settings first.",
      { status: 400 },
    );
  }

  const orderId = req.data.$action?.record_id;
  const jobs = orderId
    ? await req.swell.get(`/apps/${req.appId}/fulfillments`, {
        order_id: orderId,
        limit: 1,
      })
    : null;
  const job = jobs?.results?.[0];

  if (!job) {
    throw new SwellError("This order was not sent to Printful.", {
      status: 400,
    });
  }

  if (job.state !== "failed") {
    throw new SwellError(
      "This order is not marked failed, so there is nothing to recheck.",
      { status: 400 },
    );
  }

  const order = await new Printful(settings.api_token).getOrderByExternalId(
    job.external_id,
  );

  // A job that failed before its Printful order was created has nothing to
  // track; setting it back to Pending creates the order again.
  if (!order) {
    throw new SwellError(
      "Printful has no order for this one. To send it again, set its Printful fulfillment back to Pending.",
      { status: 400 },
    );
  }

  if (order.status === "failed") {
    throw new SwellError(
      "Printful still reports this order as failed. Fix it in Printful, then recheck.",
      { status: 400 },
    );
  }

  // Unconfirmed, so not paid for: tracking it would wait on an order that
  // never goes into production.
  if (order.status === "draft") {
    throw new SwellError(
      "This order is still a draft in Printful. Confirm it there, then recheck.",
      { status: 400 },
    );
  }

  // Confirmed with a check due now: fulfillment-advance tracks it from here,
  // adding its shipments as they ship.
  await req.swell.put(`/apps/${req.appId}/fulfillments/${job.id}`, {
    state: "confirmed",
    attempts: 0,
    last_error: null,
    date_next_attempt: new Date().toISOString(),
  });

  // Tracking writes only the Printful status to the order, so the failure it
  // recorded is cleared here.
  await req.swell.put(
    `/orders/${orderId}`,
    req.appValues({
      submit_state: "confirmed",
      printful_status: order.status,
      last_error: null,
    }),
  );

  return {
    message: `Printful reports this order as ${order.status}. Tracking resumed, and its shipments will appear on the order shortly.`,
  };
}
