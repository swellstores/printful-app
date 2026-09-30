import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockRequest } from "../helpers/mock-request";

vi.mock("../../functions/lib/products", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../functions/lib/products")>()),
  resyncProducts: vi.fn(),
}));

import { post as productResync } from "../../functions/product-resync";
import { resyncProducts } from "../../functions/lib/products";

const SETTINGS = { api_token: "token" };

function request(data: object, get: (url: string, query?: any) => any) {
  return createMockRequest({
    data: data as SwellData,
    swell: { get: vi.fn(async (url: string, query?: any) => get(url, query)) },
  });
}

beforeEach(() => {
  vi.mocked(resyncProducts).mockReset();
});

describe("product-resync", () => {
  const PRINTFUL_PRODUCT = { id: "p1", name: "Tee", $app: { printful: { sync_product_id: 9 } } };

  it("refuses a product that did not come from Printful", async () => {
    const req = request(
      { $action: { id: "resync", source: "record", record_id: "p2" } },
      (url) => (url.startsWith("/settings/") ? SETTINGS : { id: "p2", name: "Mug" }),
    );

    await expect(productResync(req)).rejects.toMatchObject({
      status: 400,
      message: "None of these products came from Printful.",
    });
    expect(resyncProducts).not.toHaveBeenCalled();
  });

  it("resyncs the product a record action ran on, keeping its photos by default", async () => {
    vi.mocked(resyncProducts).mockResolvedValue({
      resynced: 1, retired: 0, remaining: 0, skipped: 0, errors: [],
    });
    const req = request(
      { $action: { id: "resync", source: "record", record_id: "p1" } },
      (url) => (url.startsWith("/settings/") ? SETTINGS : PRINTFUL_PRODUCT),
    );

    await expect(productResync(req)).resolves.toEqual({
      message: "Resynced 1 product from Printful.",
    });
    expect(vi.mocked(resyncProducts).mock.calls[0][2]).toEqual([PRINTFUL_PRODUCT]);
    expect(vi.mocked(resyncProducts).mock.calls[0][3]).toEqual({ replaceImages: false });
  });

  it("reads the Printful products in a bulk selection, oldest-synced first", async () => {
    vi.mocked(resyncProducts).mockResolvedValue({
      resynced: 2, retired: 0, remaining: 1, skipped: 0, errors: [],
    });

    let productsQuery: any;
    const listWhere = { active: true };

    // Select all in a filtered list, with one row unchecked: the list's own
    // query, and a top-level $and that excludes the unchecked row
    const req = request(
      {
        replace_images: true,
        $action: {
          id: "resync_selected",
          source: "bulk",
          selection: {
            all: true,
            except_ids: ["p9"],
            count: 20,
            query: {
              search: "tee",
              categories: "c1",
              where: listWhere,
              $and: [{ id: { $nin: ["p9"] } }],
            },
          },
        },
      },
      (url, query) => {
        if (url.startsWith("/settings/")) return SETTINGS;
        productsQuery = query;
        return {
          count: 15,
          results: [PRINTFUL_PRODUCT, { ...PRINTFUL_PRODUCT, id: "p3" }, { ...PRINTFUL_PRODUCT, id: "p4" }],
        };
      },
    );

    const { message } = await productResync(req);

    // The list query is kept whole, and only narrowed to Printful products.
    expect(productsQuery).toEqual({
      search: "tee",
      categories: "c1",
      $and: [{ id: { $nin: ["p9"] } }],
      where: {
        $and: [listWhere, { "$app.printful.sync_product_id": { $ne: null } }],
      },
      sort: "$app.printful.date_synced asc",
      limit: 10,
    });
    expect(vi.mocked(resyncProducts).mock.calls[0][3]).toEqual({ replaceImages: true });

    // 15 Printful products selected: 2 done, 1 not reached in this batch and
    // 12 not read yet. 5 of the 20 selected are not from Printful.
    expect(message).toBe(
      "Resynced 2 products from Printful. 13 more to go; run it again to continue. " +
        "5 products not from Printful, skipped.",
    );
  });

  it("fails when nothing could be resynced", async () => {
    vi.mocked(resyncProducts).mockResolvedValue({
      resynced: 0, retired: 0, remaining: 0, skipped: 0, errors: ["Tee: Printful is down"],
    });
    const req = request(
      { $action: { id: "resync", source: "record", record_id: "p1" } },
      (url) => (url.startsWith("/settings/") ? SETTINGS : PRINTFUL_PRODUCT),
    );

    await expect(productResync(req)).rejects.toMatchObject({
      status: 400,
      message: "Resynced 0 products from Printful. Errors: Tee: Printful is down",
    });
  });
});
