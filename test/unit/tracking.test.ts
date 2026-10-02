import { describe, it, expect, vi, afterEach } from "vitest";
import { createMockRequest } from "../helpers/mock-request";
import handler from "../../functions/fulfillment-advance";
import { FAILED_MESSAGE, recordShipments } from "../../functions/lib/tracking";

const ORDER_ITEMS = [
  { id: "item_1", product_id: "p1", variant_id: "v1", quantity: 2 },
  { id: "item_2", product_id: "p2", variant_id: "v2", quantity: 1 },
];

function shipment(id: number, status: string, itemIds: string[]) {
  return {
    id,
    shipment_status: status,
    carrier: "USPS",
    service: "First Class",
    tracking_number: `9400${id}`,
    tracking_url: `https://track.example.com/${id}`,
    shipment_items: itemIds.map((external) => ({
      order_item_external_id: external,
      quantity: 1,
    })),
  };
}

function swellFor(recordedShipmentIds: string[] = []) {
  const posts: any[] = [];
  const puts: Array<{ url: string; values: any }> = [];

  const get = vi.fn(async (url: string) => {
    if (url.startsWith("/settings/")) return { api_token: "token" };
    if (url === "/shipments") {
      return {
        results: recordedShipmentIds.map((id) => ({
          $app: { printful: { shipment_id: id } },
        })),
      };
    }
    if (url === "/orders/{id}") return { id: "order_1", items: ORDER_ITEMS };
    throw new Error(`unexpected get: ${url}`);
  });

  const post = vi.fn(async (url: string, data: any) => {
    posts.push({ url, data });
    return { id: "shipment" };
  });

  const put = vi.fn(async (url: string, values: any) => {
    puts.push({ url, values });
    return { id: "job_1" };
  });

  return { swell: { get, post, put }, posts, puts };
}

function json(status: number, body: object) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Printful answers for one order and its shipments. */
function mockPrintful(order: object | null, shipments: object[] = []) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/v2/orders/@swell_order_1")) {
      return order ? json(200, { data: order }) : json(404, { code: 404, result: "Not found" });
    }
    if (url.endsWith("/v2/orders/777/shipments")) {
      return json(200, { data: shipments });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

/** A confirmed job whose next check is due. */
function confirmedJob(overrides: object = {}) {
  return {
    id: "job_1",
    order_id: "order_1",
    external_id: "swell_order_1",
    state: "confirmed",
    printful_status: "pending",
    printful_order_id: "777",
    attempts: 0,
    date_next_attempt: new Date(Date.now() - 1000).toISOString(),
    ...overrides,
  };
}

/** The last write to the job, i.e. what it was left as. */
function lastJobWrite(puts: Array<{ url: string; values: any }>) {
  return [...puts].reverse().find((write) => write.url.includes("/fulfillments/"))?.values;
}

function orderWrites(puts: Array<{ url: string; values: any }>) {
  return puts
    .filter((write) => write.url === "/orders/order_1")
    .map((write) => write.values.$app.printful);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recordShipments", () => {
  it("adds shipped shipments, matched back to the Swell line items", async () => {
    const { swell, posts } = swellFor();
    const req = createMockRequest({ swell });

    const added = await recordShipments(req, "order_1", [
      shipment(1, "shipped", ["item_1"]),
      shipment(2, "packaged", ["item_2"]),
    ]);

    expect(added).toBe(1);
    expect(posts).toEqual([
      {
        url: "/shipments",
        data: {
          order_id: "order_1",
          items: [{ order_item_id: "item_1", product_id: "p1", variant_id: "v1", quantity: 1 }],
          carrier: "USPS",
          service: "First Class",
          tracking_code: "94001",
          $app: {
            printful: { shipment_id: "1", tracking_url: "https://track.example.com/1" },
          },
        },
      },
    ]);
  });

  it("skips shipments already on the order", async () => {
    const { swell, posts } = swellFor(["1"]);
    const req = createMockRequest({ swell });

    const added = await recordShipments(req, "order_1", [
      shipment(1, "shipped", ["item_1"]),
      shipment(2, "shipped", ["item_2"]),
    ]);

    expect(added).toBe(1);
    expect(posts.map((p) => p.data.$app.printful.shipment_id)).toEqual(["2"]);
  });
});

describe("tracking a confirmed order", () => {
  it("records shipments and keeps checking while items are still to ship", async () => {
    mockPrintful({ id: 777, status: "partial" }, [shipment(1, "shipped", ["item_1"])]);
    const { swell, posts, puts } = swellFor();

    await handler(createMockRequest({ data: confirmedJob(), swell }));

    expect(posts).toHaveLength(1);
    const job = lastJobWrite(puts);
    expect(job.printful_status).toBe("partial");
    expect(Date.parse(job.date_next_attempt)).toBeGreaterThan(Date.now() + 9 * 60 * 1000);
    expect(orderWrites(puts)).toEqual([{ printful_status: "partial" }]);
  });

  it("stops checking once everything has shipped", async () => {
    mockPrintful({ id: 777, status: "fulfilled" }, [shipment(1, "shipped", ["item_1", "item_2"])]);
    const { swell, puts } = swellFor();

    await handler(createMockRequest({ data: confirmedJob(), swell }));

    expect(lastJobWrite(puts)).toMatchObject({ printful_status: "fulfilled", date_next_attempt: null });
  });

  it("leaves the order alone when Printful's status has not changed", async () => {
    mockPrintful({ id: 777, status: "inprocess" });
    const { swell, puts } = swellFor();

    await handler(createMockRequest({ data: confirmedJob({ printful_status: "inprocess" }), swell }));

    expect(orderWrites(puts)).toEqual([]);
  });

  it("fails the job when Printful rejects the order", async () => {
    mockPrintful({ id: 777, status: "failed" });
    const { swell, puts } = swellFor();

    await handler(createMockRequest({ data: confirmedJob(), swell }));

    expect(lastJobWrite(puts)).toMatchObject({ state: "failed", last_error: FAILED_MESSAGE });
    expect(orderWrites(puts)).toEqual([
      { submit_state: "failed", last_error: FAILED_MESSAGE, printful_status: "failed" },
    ]);
  });

  it("reports an error checking on the order without failing it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(502, { code: 502, result: "Bad gateway" }));
    const { swell, puts } = swellFor();

    await handler(createMockRequest({ data: confirmedJob(), swell }));

    const job = lastJobWrite(puts);
    expect(job.state).toBeUndefined();
    expect(job.last_error).toBe("Bad gateway");
    expect(Date.parse(job.date_next_attempt)).toBeGreaterThan(Date.now());
  });

  it("does nothing before the next check is due", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { swell } = swellFor();
    const later = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    await handler(createMockRequest({ data: confirmedJob({ date_next_attempt: later }), swell }));

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
