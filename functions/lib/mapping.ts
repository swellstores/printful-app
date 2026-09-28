export interface SwellItem {
  id?: string;
  product_id?: string;
  variant_id?: string;
  quantity?: number;
}

/** A Swell variant linked to the Printful variant it was synced from. */
export interface VariantLink {
  id: string;
  variant_id: string;
  sync_variant_id: number;
  catalog_variant_id: number;
}

export interface RateItem {
  source: "catalog";
  catalog_variant_id: number;
  quantity: number;
}

/** Printful links for the variants in a cart, keyed by Swell variant id. */
export async function getVariantLinks(
  req: SwellRequest,
  items: SwellItem[],
): Promise<Map<string, VariantLink>> {
  const variantIds = [
    ...new Set(items.map((item) => item.variant_id).filter(Boolean)),
  ];

  if (variantIds.length === 0) {
    return new Map();
  }

  const result = await req.swell.get(`/apps/${req.appId}/sync-variants`, {
    variant_id: { $in: variantIds },
    limit: variantIds.length,
    fields: ["variant_id", "sync_variant_id", "catalog_variant_id"],
  });

  return new Map(
    (result?.results ?? []).map((row: VariantLink) => [
      String(row.variant_id),
      row,
    ]),
  );
}

/**
 * Shipping depends on the blank, not the design, so quotes ask for the catalog
 * variant the design is printed on.
 */
export function toRateItems(
  items: SwellItem[],
  links: Map<string, VariantLink>,
): RateItem[] {
  const rateItems: RateItem[] = [];

  for (const item of items) {
    const link = links.get(String(item.variant_id));

    if (link) {
      rateItems.push({
        source: "catalog",
        catalog_variant_id: link.catalog_variant_id,
        quantity: item.quantity || 1,
      });
    }
  }

  return rateItems;
}

/**
 * Order items for v1 `POST /orders`. A sync variant carries its own print
 * files, so Printful prints exactly what was designed there. `external_id` is
 * the Swell order item id, which is what makes shipment items matchable back to
 * Swell line items later.
 */
export function toOrderItems(
  items: SwellItem[],
  links: Map<string, VariantLink>,
) {
  const orderItems = [];

  for (const item of items) {
    const link = links.get(String(item.variant_id));

    if (link) {
      orderItems.push({
        sync_variant_id: link.sync_variant_id,
        quantity: item.quantity || 1,
        external_id: item.id,
      });
    }
  }

  return orderItems;
}

/** Undefined keys drop out of the JSON body, so this shape serves both the
 * quote request (which only needs the destination) and order creation. */
export function toRecipient(shipping: Record<string, any> = {}, email?: string) {
  return {
    name: shipping.name,
    address1: shipping.address1,
    address2: shipping.address2,
    city: shipping.city,
    state_code: shipping.state,
    country_code: shipping.country,
    zip: shipping.zip,
    phone: shipping.phone,
    email,
  };
}
