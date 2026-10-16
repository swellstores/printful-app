import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockRequest } from "../helpers/mock-request";

vi.mock("../../functions/lib/products", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../functions/lib/products")>()),
  resyncProducts: vi.fn(),
}));

import { post as productResync } from "../../functions/product-resync";
import { post as orderRecheck } from "../../functions/order-recheck";
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

describe("order-recheck", () => {
  const FAILED_JOB = {
    id: "job_1",
    order_id: "o1",
    external_id: "o1",
    state: "failed",
    printful_order_id: "777",
  };
  const ACTION = { $action: { id: "recheck", source: "record", record_id: "o1" } };

  /** A store holding `job` for order o1, with writes recorded on `put`. */
  function store(job: object | null) {
    const put = vi.fn(async () => ({}));
    const req = createMockRequest({
      data: ACTION as SwellData,
      swell: {
        get: vi.fn(async (url: string) => {
          if (url.startsWith("/settings/")) return SETTINGS;
          if (url === "/apps/printful/fulfillments") return { results: job ? [job] : [] };
          throw new Error(`unexpected GET ${url}`);
        }),
        put,
      },
    });
    return { req, put };
  }

  /** Printful answering for the order with `status`, or 404 for none. */
  function printful(status: string | null) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/v2/orders/@o1")) {
        return status
          ? new Response(JSON.stringify({ data: { id: 777, status } }))
          : new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
  }

  it("refuses an order that was not sent to Printful", async () => {
    const { req, put } = store(null);

    await expect(orderRecheck(req)).rejects.toMatchObject({
      status: 400,
      message: "This order was not sent to Printful.",
    });
    expect(put).not.toHaveBeenCalled();
  });

  it("refuses an order that is not marked failed", async () => {
    const { req, put } = store({ ...FAILED_JOB, state: "confirmed" });
    const fetch = printful("inprocess");

    await expect(orderRecheck(req)).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("leaves an order Printful still reports as failed", async () => {
    const { req, put } = store(FAILED_JOB);
    printful("failed");

    await expect(orderRecheck(req)).rejects.toMatchObject({
      status: 400,
      message: "Printful still reports this order as failed. Fix it in Printful, then recheck.",
    });
    expect(put).not.toHaveBeenCalled();
  });

  it("leaves an order that is still a draft in Printful", async () => {
    const { req, put } = store(FAILED_JOB);
    printful("draft");

    await expect(orderRecheck(req)).rejects.toMatchObject({ status: 400 });
    expect(put).not.toHaveBeenCalled();
  });

  it("points to Pending when Printful has no order", async () => {
    const { req, put } = store(FAILED_JOB);
    printful(null);

    await expect(orderRecheck(req)).rejects.toMatchObject({
      status: 400,
      message:
        "Printful has no order for this one. To send it again, set its Printful fulfillment back to Pending.",
    });
    expect(put).not.toHaveBeenCalled();
  });

  it("tracks a fixed order again and clears its failure", async () => {
    const { req, put } = store(FAILED_JOB);
    printful("fulfilled");

    await expect(orderRecheck(req)).resolves.toEqual({
      message:
        "Printful reports this order as fulfilled. Tracking resumed, and its shipments will appear on the order shortly.",
    });

    const [jobWrite, orderWrite] = put.mock.calls as any[];
    expect(jobWrite[0]).toBe("/apps/printful/fulfillments/job_1");
    expect(jobWrite[1]).toMatchObject({ state: "confirmed", attempts: 0, last_error: null });
    expect(Date.parse(jobWrite[1].date_next_attempt)).toBeLessThanOrEqual(Date.now());
    expect(orderWrite[0]).toBe("/orders/o1");
    expect(orderWrite[1]).toEqual(
      req.appValues({ submit_state: "confirmed", printful_status: "fulfilled", last_error: null }),
    );
  });
});
