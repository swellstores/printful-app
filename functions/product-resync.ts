import { getSettings } from "./lib/settings";
import { describeResync, resyncProducts } from "./lib/products";

export const config: SwellConfig = {
  description: "Resync a product from Printful from its page in the Swell admin",
  action: {},
};

/**
 * Re-reads the product the action ran on from Printful. Resyncing products
 * selected in the list runs in the background instead; see resync-products.
 */
export async function post(req: SwellRequest) {
  const settings = await getSettings(req);

  if (!settings.api_token) {
    throw new SwellError(
      "Add your Printful API token in the app settings first.",
      { status: 400 },
    );
  }

  const recordId = req.data.$action?.record_id;
  const product = recordId ? await req.swell.get(`/products/${recordId}`) : null;

  if (!product?.$app?.[req.appId as string]?.sync_product_id) {
    throw new SwellError("None of these products came from Printful.", {
      status: 400,
    });
  }

  const result = await resyncProducts(req, settings, [product]);
  const message = describeResync(result);

  if (result.resynced + result.retired === 0 && result.errors.length > 0) {
    throw new SwellError(message, { status: 400 });
  }

  return { message };
}
