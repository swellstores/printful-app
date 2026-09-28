import { describe, it, expect, vi, afterEach } from "vitest";
import { createMockRequest } from "../helpers/mock-request";
import handler from "../../functions/fulfillment-advance";
import { toOrderItems, toRateItems } from "../../functions/lib/mapping";
import type { VariantLink } from "../../functions/lib/mapping";

const LINK: VariantLink = {
  id: "link_1",
  variant_id: "variant_1",
  sync_variant_id: 5001,
  catalog_variant_id: 4012,
};

const LINKS = new Map<string, VariantLink>([["variant_1", LINK]]);

const LINKED_ITEM = { id: "item_1", variant_id: "variant_1", quantity: 2 };
const UNLINKED_ITEM = { id: "item_2", variant_id: "variant_9", quantity: 1 };

/**
 * Drives the create pass of the fulfillment job. The job is `pending` with no
 * next attempt, which is the documented operator retry and runs immediately.
 */
function driveCreate(orderItems: any[], links: VariantLink[]) {
  const puts: Array<{ url: string; values: any }> = [];

  const get = vi.fn(async (url: string) => {
    if (url.startsWith("/settings/")) {
      return { api_token: "token", store_id: "1" };
    }

    if (url === "/orders/{id}") {
      return {
        id: "order_1",
        email: "ana@example.com",
        shipping: { name: "Ana Torres", country: "US", service: "printful_STANDARD" },
        items: orderItems,
      };
    }

    if (url.endsWith("/sync-variants")) {
      return { results: links };
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

function jsonResponse(status: number, body: object) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("toOrderItems", () => {
  it("orders the linked Printful variant so its stored print files are used", () => {
    expect(toOrderItems([LINKED_ITEM], LINKS)).toEqual([
      { sync_variant_id: 5001, quantity: 2, external_id: "item_1" },
    ]);
  });

  it("leaves out items that are not linked to Printful", () => {
    expect(toOrderItems([UNLINKED_ITEM], LINKS)).toEqual([]);
  });
});

describe("toRateItems", () => {
  it("quotes the catalog variant the design is printed on", () => {
    expect(toRateItems([LINKED_ITEM, UNLINKED_ITEM], LINKS)).toEqual([
      { source: "catalog", catalog_variant_id: 4012, quantity: 2 },
    ]);
  });
});

describe("create pass", () => {
  it("fails an order with no linked item before any Printful call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { req, puts } = driveCreate([UNLINKED_ITEM], []);

    await handler(req);

    expect(fetchSpy).not.toHaveBeenCalled();

    const failed = puts.find(
      (write) =>
        write.url.includes("/fulfillments/") && write.values.state === "failed",
    );
    expect(failed?.values.last_error).toBe(
      "No order item is linked to a Printful product",
    );
  });

  it("creates a v1 draft that references the sync variant", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.endsWith("/v2/orders/@swell_order_1")) {
          return jsonResponse(404, { code: 404, result: "Not found" });
        }

        if (url.endsWith("/orders")) {
          return jsonResponse(200, {
            code: 200,
            result: { id: 777, status: "draft" },
          });
        }

        throw new Error(`unexpected fetch: ${url}`);
      });

    const { req, puts } = driveCreate([LINKED_ITEM, UNLINKED_ITEM], [LINK]);

    await handler(req);

    const create = fetchSpy.mock.calls.find(([input]) =>
      String(input).endsWith("/orders"),
    );

    // No `confirm` parameter: the order stays a draft until live fulfillment
    // allows the separate confirmation call.
    expect(String(create?.[0])).toBe("https://api.printful.com/orders");

    const body = JSON.parse(String((create?.[1] as RequestInit).body));

    expect(body).toMatchObject({
      external_id: "swell_order_1",
      shipping: "STANDARD",
      items: [{ sync_variant_id: 5001, quantity: 2, external_id: "item_1" }],
    });

    // The claim also writes `created` before any Printful call; the job record
    // that follows the create is the one carrying the Printful order id.
    const created = puts.find(
      (write) =>
        write.url.includes("/fulfillments/") &&
        write.values.state === "created" &&
        "printful_order_id" in write.values,
    );
    expect(created?.values.printful_order_id).toBe("777");
  });
});
