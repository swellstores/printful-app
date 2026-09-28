import { describe, it, expect, vi, afterAll } from "vitest";
import { env } from "cloudflare:test";
import { createMockRequest } from "../helpers/mock-request";
import { runProductSync } from "../../functions/lib/products";

// Runs the real sync against the Swell test environment of the logged-in store,
// with Printful answered from fixtures. It creates one draft product and
// deletes it again at the end.
const PRINTFUL = "https://api.printful.com";
const SYNC_PRODUCT_ID = 900000000 + (Date.now() % 1000000);
const NAME = `zz Printful sync test ${SYNC_PRODUCT_ID}`;

function syncVariant(id: number, color: string, size: string, price = "25.00") {
  return {
    id: SYNC_PRODUCT_ID * 10 + id,
    name: `${NAME} / ${color} / ${size}`,
    variant_id: 4000 + id,
    retail_price: price,
    currency: "USD",
    sku: `TEE-${color}-${size}`,
    color,
    size,
    product: { product_id: 71 },
    files: [
      {
        type: "preview",
        preview_url: `https://files.cdn.printful.com/files/test/${color}.png`,
      },
    ],
  };
}

let printfulVariants = [
  syncVariant(1, "Black", "S"),
  syncVariant(2, "Black", "M"),
  syncVariant(3, "Black", "2XL", "27.00"),
  syncVariant(4, "White", "S"),
  syncVariant(5, "White", "M"),
];
let listed = true;

function json(body: object) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function mockPrintful() {
  const realFetch = globalThis.fetch.bind(globalThis);

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);

    if (!url.startsWith(PRINTFUL)) {
      return realFetch(input, init);
    }

    if (url.startsWith(`${PRINTFUL}/store/products?`)) {
      const result = listed
        ? [{ id: SYNC_PRODUCT_ID, name: NAME, variants: printfulVariants.length }]
        : [];
      return json({
        code: 200,
        result,
        paging: { total: result.length, offset: 0, limit: 100 },
      });
    }

    if (url === `${PRINTFUL}/store/products/${SYNC_PRODUCT_ID}`) {
      return json({
        code: 200,
        result: {
          sync_product: { id: SYNC_PRODUCT_ID, name: NAME },
          sync_variants: printfulVariants,
        },
      });
    }

    if (url === `${PRINTFUL}/v2/catalog-products/71`) {
      return json({ data: { id: 71, description: "Soft tee.\n\n• 100% cotton" } });
    }

    throw new Error(`unexpected Printful call: ${url}`);
  });
}

const available = Boolean(env.SWELL_SESSION_ID);

// Every step makes real Swell API calls; a run that outlives vitest's default
// timeout keeps going in the background and races the next test.
describe.skipIf(!available)("product sync against Swell", { timeout: 60000 }, () => {
  const req = createMockRequest({ useRealSwell: true });
  const settings = { api_token: "test-token" };
  let productId: string | undefined;

  const links = async () =>
    (
      await req.swell.get(`/apps/${req.appId}/sync-variants`, {
        sync_product_id: SYNC_PRODUCT_ID,
        limit: 100,
      })
    )?.results ?? [];

  const variantsByName = async () => {
    const result = await req.swell.get(`/products/${productId}/variants`, {
      limit: 100,
    });
    return new Map<string, any>(
      (result?.results ?? []).map((v: any) => [v.name, v]),
    );
  };

  afterAll(async () => {
    vi.restoreAllMocks();

    for (const link of await links()) {
      await req.swell.delete(`/apps/${req.appId}/sync-variants/${link.id}`);
    }

    if (productId) {
      await req.swell.delete(`/products/${productId}`);
    }
  });

  it("creates a draft product with Printful's variants, prices and mockups", async () => {
    mockPrintful();

    const result = await runProductSync(req, settings);

    expect(result.errors).toEqual([]);
    expect(result.created).toBe(1);

    const found = await req.swell.get("/products", {
      [`$app.${req.appId}.sync_product_id`]: SYNC_PRODUCT_ID,
    });
    const product = found?.results?.[0];
    productId = product?.id;

    expect(product).toMatchObject({ name: NAME, active: false, price: 25 });
    expect(product.options.map((o: any) => o.name)).toEqual(["Color", "Size"]);
    expect(product.images.map((i: any) => i.file.url)).toEqual([
      "https://files.cdn.printful.com/files/test/Black.png",
      "https://files.cdn.printful.com/files/test/White.png",
    ]);
    expect(product.description).toContain("<p>Soft tee.</p>");
    expect(product.$app[req.appId].sync_variant_count).toBe(5);

    const variants = await variantsByName();

    expect(variants.size).toBe(6);
    expect(variants.get("White, 2XL")?.active).toBe(false);
    expect(variants.get("Black, 2XL")?.price).toBe(27);
    expect(variants.get("Black, S")).toMatchObject({ active: true, sku: "TEE-Black-S" });

    const rows = await links();
    expect(rows).toHaveLength(5);
    expect(
      rows.every((row: any) => [...variants.values()].some((v) => v.id === row.variant_id)),
    ).toBe(true);
  });

  it("takes a variant removed in Printful off sale", async () => {
    printfulVariants = printfulVariants.filter((v) => v.color !== "White" || v.size !== "M");

    const result = await runProductSync(req, settings);

    expect(result.errors).toEqual([]);
    expect(result.updated).toBe(1);
    expect((await variantsByName()).get("White, M")?.active).toBe(false);
    expect(await links()).toHaveLength(4);
  });

  it("takes a product deleted in Printful off sale", async () => {
    await req.swell.put(`/products/${productId}`, { active: true });
    listed = false;

    const result = await runProductSync(req, settings);

    expect(result.errors).toEqual([]);
    expect(result.retired).toBe(1);
    expect((await req.swell.get(`/products/${productId}`))?.active).toBe(false);
    expect(await links()).toHaveLength(0);
  });
});
