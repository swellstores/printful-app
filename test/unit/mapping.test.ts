import { describe, it, expect, vi, afterEach } from "vitest";
import { createMockRequest } from "../helpers/mock-request";
import handler from "../../functions/fulfillment-advance";
import { toOrderItems } from "../../functions/lib/mapping";
import type { CatalogItem, SwellItem } from "../../functions/lib/mapping";

const CATALOG = new Map<string, CatalogItem>([
  ["variant_1", { id: "cat_1", variant_id: "variant_1", catalog_variant_id: 4012 }],
]);

const CATALOG_ROW = {
  variant_id: "variant_1",
  catalog_variant_id: 4012,
  catalog_product_id: 71,
};

/** A product the merchant never configured for printing at all. */
const UNCONFIGURED: SwellItem = {
  id: "item_1",
  variant_id: "variant_1",
  quantity: 1,
  product: {},
};

/** Two placements listed, only one of them given a print file. */
const PARTIAL: SwellItem = {
  id: "item_1",
  variant_id: "variant_1",
  quantity: 1,
  product: {
    $app: {
      printful: {
        placements: [
          {
            placement: "front",
            artwork_url: "https://cdn.example.com/front.png",
          },
          { placement: "back" },
        ],
      },
    },
  },
};

/**
 * Drives the create pass of the fulfillment job. The job is `pending` with no
 * next attempt, which is the documented operator retry and runs immediately.
 */
function driveCreate(orderItems: any[]) {
  const puts: Array<{ url: string; values: any }> = [];

  const get = vi.fn(async (url: string) => {
    if (url.startsWith("/settings/")) {
      return { api_token: "token", store_id: "1" };
    }

    if (url === "/orders/{id}") {
      return { id: "order_1", items: orderItems };
    }

    if (url.endsWith("/catalog-items")) {
      return { results: [CATALOG_ROW] };
    }

    throw new Error(`unexpected get: ${url}`);
  });

  const put = vi.fn(async (url: string, values: any) => {
    puts.push({ url, values });
    return { id: "job_1" };
  });

  const req = createMockRequest({
    data: {
      id: "job_1",
      order_id: "order_1",
      external_id: "swell_order_1",
      state: "pending",
      date_next_attempt: null,
    },
    swell: { get, put },
  });

  return { req, puts };
}

/** The write that parked the job, i.e. what the merchant is shown. */
function failure(puts: Array<{ url: string; values: any }>) {
  return puts.find(
    (write) =>
      write.url.includes("/fulfillments/") && write.values.state === "failed",
  )?.values;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("toOrderItems", () => {
  it("reports a configured placement with no print file", () => {
    const { orderItems, missingArtwork } = toOrderItems([PARTIAL], CATALOG);

    // The item still maps, and the unprintable placement is reported rather
    // than quietly dropped — dropping it leaves a non-empty placements array
    // that clears the zero-placement guard.
    expect(orderItems).toHaveLength(1);
    expect(orderItems[0].placements.map((p) => p.placement)).toEqual(["front"]);
    expect(missingArtwork).toEqual([
      { external_id: "item_1", placement: "back" },
    ]);
  });

  it("resolves an unconfigured product to zero placements", () => {
    const { orderItems, missingArtwork } = toOrderItems(
      [UNCONFIGURED],
      CATALOG,
    );

    expect(orderItems[0].placements).toEqual([]);
    // The synthesized default placement is not reported as missing artwork;
    // the caller reports the product as unconfigured instead.
    expect(missingArtwork).toEqual([]);
  });
});

describe("create pass guards", () => {
  it("refuses an order item with no print placement", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { req, puts } = driveCreate([
      { ...UNCONFIGURED, product: { name: "Blank Tee" } },
    ]);

    await handler(req);

    // The refusal must land before any Printful I/O: a draft created here is a
    // blank garment Printful prints and charges for.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(String(failure(puts)?.last_error)).toContain(
      'No Printful print placement is configured for product "Blank Tee"',
    );
  });

  it("refuses an order item missing artwork for a configured placement", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { req, puts } = driveCreate([
      {
        ...PARTIAL,
        product: { ...PARTIAL.product, name: "Logo Tee" },
      },
    ]);

    await handler(req);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(String(failure(puts)?.last_error)).toContain(
      'No artwork is configured for the "back" print placement on product "Logo Tee"',
    );
  });
});
