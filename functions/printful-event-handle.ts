import Printful from "./lib/printful";
import { getSettings } from "./lib/settings";

const TRANSACTION_SIZE = 10;
const MAX_STALE_ROWS = 100;

// After this many failed deliveries stop retrying. An event that cannot be
// handled must not keep failing until the platform auto-disables the function;
// it stays unprocessed with its error for an operator to replay.
const MAX_DELIVERIES = 3;

export const config: SwellConfig = {
  description: "Enrich and apply a verified Printful event",
  model: {
    events: ["printful-event.created"],
  },
};

function mirrorOrder(req: SwellRequest, orderId: string, values: object) {
  return req.swell.put(`/orders/${orderId}`, req.appValues(values));
}

async function findFulfillment(req: SwellRequest, data: any) {
  const externalId = data.order?.external_id ?? data.external_id;
  const printfulOrderId = data.order?.id ?? data.order_id;

  const where = externalId
    ? { external_id: String(externalId) }
    : printfulOrderId
      ? { printful_order_id: String(printfulOrderId) }
      : null;

  if (!where) {
    return null;
  }

  const result = await req.swell.get(`/apps/${req.appId}/fulfillments`, {
    ...where,
    limit: 1,
  });

  return result?.results?.[0] ?? null;
}

async function handleShipmentSent(
  req: SwellRequest,
  printful: Printful,
  data: any,
) {
  const fulfillment = await findFulfillment(req, data);

  if (!fulfillment) {
    return;
  }

  const printfulOrderId = fulfillment.printful_order_id || data.order?.id;
  const shipmentId = String(data.shipment?.id ?? data.shipment_id ?? "");

  // The event carries a tracking number but no carrier and no item list, and
  // Printful splits an order across shipments, so the shipment has to be read
  // back before anything can be written to Swell.
  const shipments = await printful.listShipments(String(printfulOrderId));
  const shipment = shipments.find((s: any) => String(s.id) === shipmentId);

  if (!shipment) {
    throw new Error(
      `Printful shipment ${shipmentId} not found on order ${printfulOrderId}`,
    );
  }

  const trackingCode = shipment.tracking_number;

  const existing = await req.swell.get("/shipments", {
    order_id: fulfillment.order_id,
    tracking_code: trackingCode,
    limit: 1,
  });

  if (existing?.count) {
    return;
  }

  const order = await req.swell.get("/orders/{id}", {
    id: fulfillment.order_id,
    fields: ["items"],
  });

  const orderItems = new Map<string, any>(
    (order?.items ?? []).map((item: any) => [String(item.id), item]),
  );

  const items = [];

  // Order creation set each item's external_id to the Swell order item id,
  // which is what makes this match possible.
  for (const line of shipment.items ?? shipment.shipment_items ?? []) {
    const orderItem = orderItems.get(
      String(line.order_item_external_id ?? line.external_id),
    );

    if (!orderItem) {
      continue;
    }

    items.push({
      order_item_id: orderItem.id,
      product_id: orderItem.product_id,
      variant_id: orderItem.variant_id,
      quantity: line.quantity ?? orderItem.quantity,
    });
  }

  if (items.length === 0) {
    return;
  }

  await req.swell.post("/shipments", {
    order_id: fulfillment.order_id,
    items,
    carrier: shipment.carrier,
    service: shipment.service,
    tracking_code: trackingCode,
    // Recovering the Printful shipment id and its tracking link is most of why
    // the shipment was read back above, so both are kept on the Swell shipment
    // rather than being thrown away.
    ...req.appValues({
      shipment_id: shipmentId,
      tracking_url: shipment.tracking_url,
    }),
  });
}

async function handleOrderUpdated(req: SwellRequest, data: any) {
  const fulfillment = await findFulfillment(req, data);

  if (!fulfillment) {
    return;
  }

  await mirrorOrder(req, fulfillment.order_id, {
    printful_status: data.order?.status,
  });

  if (fulfillment.state === "confirmed" || fulfillment.state === "failed") {
    return;
  }

  // Printful finishes cost calculation asynchronously and announces it here.
  // Re-arming the job is the wake-up the backoff schedule only has to cover
  // when this event goes missing.
  await req.swell.put(
    `/apps/${req.appId}/fulfillments/${fulfillment.id}`,
    { date_next_attempt: new Date().toISOString() },
  );
}

async function handleOrderFailed(req: SwellRequest, data: any) {
  const fulfillment = await findFulfillment(req, data);

  if (!fulfillment) {
    return;
  }

  const reason =
    data.reason ??
    data.order?.error ??
    "Printful rejected this order. Print files are validated after confirmation, so this can arrive well after the order was placed.";

  await req.swell.put(`/apps/${req.appId}/fulfillments/${fulfillment.id}`, {
    state: "failed",
    last_error: reason,
    date_next_attempt: null,
  });

  await mirrorOrder(req, fulfillment.order_id, {
    submit_state: "failed",
    printful_status: data.order?.status ?? "failed",
    last_error: reason,
  });
}

async function handleOrderStatus(
  req: SwellRequest,
  data: any,
  fallbackStatus: string,
) {
  const fulfillment = await findFulfillment(req, data);

  if (!fulfillment) {
    return;
  }

  // Cancellations and refunds are reported, never acted on: the app does not
  // cancel or refund the Swell order on Printful's behalf.
  await mirrorOrder(req, fulfillment.order_id, {
    printful_status: data.order?.status ?? fallbackStatus,
  });
}

async function markStale(req: SwellRequest, data: any) {
  const productIds = (data.catalog_product_ids ?? []).map(Number);
  const variantIds = (data.catalog_variant_ids ?? []).map(Number);

  const where = productIds.length
    ? { catalog_product_id: { $in: productIds } }
    : variantIds.length
      ? { catalog_variant_id: { $in: variantIds } }
      : null;

  if (!where) {
    return;
  }

  const collection = `/apps/${req.appId}/catalog-items`;

  const result = await req.swell.get(collection, {
    ...where,
    stale: { $ne: true },
    limit: MAX_STALE_ROWS,
    fields: ["id"],
  });

  const rows = result?.results ?? [];

  for (let i = 0; i < rows.length; i += TRANSACTION_SIZE) {
    await req.swell.transaction(
      rows.slice(i, i + TRANSACTION_SIZE).map((row: any) => ({
        method: "put" as const,
        url: `${collection}/${row.id}`,
        data: { stale: true },
      })),
    );
  }
}

export default async function (req: SwellRequest) {
  const event = req.data;

  if (event.processed) {
    return;
  }

  const settings = await getSettings(req);
  const printful = new Printful(
    settings.api_token as string,
    settings.store_id,
  );
  const data = event.data ?? {};

  try {
    switch (event.type) {
      case "shipment_sent":
        await handleShipmentSent(req, printful, data);
        break;
      case "shipment_delivered":
        await handleOrderStatus(req, data, "delivered");
        break;
      case "order_updated":
        await handleOrderUpdated(req, data);
        break;
      case "order_failed":
        await handleOrderFailed(req, data);
        break;
      case "order_canceled":
        await handleOrderStatus(req, data, "canceled");
        break;
      case "order_refunded":
        await handleOrderStatus(req, data, "refunded");
        break;
      case "catalog_price_changed":
      case "catalog_stock_updated":
        await markStale(req, data);
        break;
    }

    await req.swell.put(`/apps/${req.appId}/printful-events/${event.id}`, {
      processed: true,
      process_error: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    await req.swell.put(`/apps/${req.appId}/printful-events/${event.id}`, {
      process_error: message,
    });

    const attempts = req.data.$event?.delivery?.attempts ?? 0;
    throw new SwellError(message, { retry: attempts < MAX_DELIVERIES });
  }
}
