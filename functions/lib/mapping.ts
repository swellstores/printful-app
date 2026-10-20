export interface SwellItem {
  id?: string;
  product_id?: string;
  variant_id?: string;
  quantity?: number;
}

/**
 * A Swell variant linked to the Printful variant it was synced from. A Swell
 * product without variants is linked as a whole, with no `variant_id`.
 */
export interface VariantLink {
  id: string;
  product_id?: string;
  variant_id?: string;
  sync_variant_id: number;
  catalog_variant_id: number;
}

/** Where an item's link is found: its variant, or its product when it has none. */
export function linkKey(item: { product_id?: string; variant_id?: string | null }) {
  return item.variant_id ? String(item.variant_id) : `product:${item.product_id}`;
}

export interface RateItem {
  source: "catalog";
  catalog_variant_id: number;
  quantity: number;
}

/** Printful links for the items in a cart or order, keyed by `linkKey`. */
export async function getVariantLinks(
  req: SwellRequest,
  items: SwellItem[],
): Promise<Map<string, VariantLink>> {
  const variantIds = [
    ...new Set(items.map((item) => item.variant_id).filter(Boolean)),
  ];
  const productIds = [
    ...new Set(
      items.filter((item) => !item.variant_id).map((item) => item.product_id).filter(Boolean),
    ),
  ];
  const fields = ["product_id", "variant_id", "sync_variant_id", "catalog_variant_id"];
  const collection = `/apps/${req.appId}/sync-variants`;

  const [byVariant, byProduct] = await Promise.all([
    variantIds.length > 0
      ? req.swell.get(collection, {
          variant_id: { $in: variantIds },
          limit: variantIds.length,
          fields,
        })
      : null,
    // A product's own variants are linked one by one, so only a link with no
    // variant stands for the whole product
    productIds.length > 0
      ? req.swell.get(collection, {
          product_id: { $in: productIds },
          limit: 1000,
          fields,
        })
      : null,
  ]);

  const links = new Map<string, VariantLink>();

  for (const row of (byVariant?.results ?? []) as VariantLink[]) {
    links.set(String(row.variant_id), row);
  }

  for (const row of (byProduct?.results ?? []) as VariantLink[]) {
    if (!row.variant_id) {
      links.set(linkKey(row), row);
    }
  }

  return links;
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
    const link = links.get(linkKey(item));

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
    const link = links.get(linkKey(item));

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
