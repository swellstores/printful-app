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

  it("resyncs the product a record action ran on", async () => {
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
