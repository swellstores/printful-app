// Printful statuses after which nothing more ships, so tracking stops
export const FINISHED_STATUSES = new Set(["fulfilled", "canceled"]);

// Statuses in which some or all items have shipped
export const SHIPPED_STATUSES = new Set(["partial", "fulfilled"]);

// Printful's order has no field saying why it failed; its dashboard does.
export const FAILED_MESSAGE =
  "Printful rejected this order. Open it in the Printful dashboard to see why.";

/**
 * Adds the Printful shipments that have shipped to the Swell order, skipping
 * any already recorded. Printful splits an order across shipments, and each
 * one is matched back to Swell line items through the external id the order
 * items were created with. Returns how many shipments were added.
 */
export async function recordShipments(
  req: SwellRequest,
  orderId: string,
  shipments: any[],
): Promise<number> {
  const shipped = shipments.filter((s) => s?.shipment_status === "shipped");

  if (shipped.length === 0) {
    return 0;
  }

  const [existing, order] = await Promise.all([
    req.swell.get("/shipments", { order_id: orderId, limit: 100 }),
    req.swell.get("/orders/{id}", { id: orderId, fields: ["items"] }),
  ]);

  const recorded = new Set(
    (existing?.results ?? []).map((s: any) =>
      String(s.$app?.[req.appId as string]?.shipment_id ?? ""),
    ),
  );

  const orderItems = new Map<string, any>(
    (order?.items ?? []).map((item: any) => [String(item.id), item]),
  );

  let added = 0;

  for (const shipment of shipped) {
    const shipmentId = String(shipment.id);

    if (recorded.has(shipmentId)) {
      continue;
    }

    const items = [];

    for (const line of shipment.shipment_items ?? []) {
      const orderItem = orderItems.get(String(line.order_item_external_id));

      if (orderItem) {
        items.push({
          order_item_id: orderItem.id,
          product_id: orderItem.product_id,
          variant_id: orderItem.variant_id,
          quantity: line.quantity ?? orderItem.quantity,
        });
      }
    }

    if (items.length === 0) {
      continue;
    }

    await req.swell.post("/shipments", {
      order_id: orderId,
      items,
      carrier: shipment.carrier,
      service: shipment.service,
      tracking_code: shipment.tracking_number,
      // The Printful shipment id is what keeps the next check from adding
      // this shipment twice, and its tracking link is Printful's to give.
      ...req.appValues({
        shipment_id: shipmentId,
        tracking_url: shipment.tracking_url,
      }),
    });

    added++;
  }

  return added;
}
