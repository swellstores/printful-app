import { describe, it, expect, vi, afterEach } from "vitest";
import { createMockRequest } from "../helpers/mock-request";
import { post as testConnection } from "../../functions/test-connection";

function json(body: object, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const scopes = () => json({ code: 200, result: { scopes: [{ scope: "orders" }, { scope: "sync_products/read" }] } });

function run(settings: object) {
  return testConnection(createMockRequest({ swell: { get: vi.fn(async () => settings) } }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("test-connection", () => {
  it("asks for the token before calling Printful", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(run({})).rejects.toMatchObject({
      status: 400,
      message: "Add the Printful API token and save the settings first.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks the scopes, then the store's products", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(scopes())
      .mockResolvedValueOnce(json({ code: 200, result: [{ id: 1 }], paging: { total: 12 } }));

    await expect(run({ api_token: "token" })).resolves.toEqual({
      message: "Connected to Printful. The token's store has 12 products.",
    });
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      "https://api.printful.com/oauth/scopes",
      "https://api.printful.com/store/products?limit=1",
    ]);
  });

  it("names a missing scope", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json({ code: 200, result: { scopes: [{ scope: "orders/read" }, { scope: "sync_products" }] } }),
    );
    await expect(run({ api_token: "token" })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("lacks the 'orders' scope"),
    });
  });

  it("explains a rejected token and an account-wide token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json({ code: 401, result: "The access token provided is invalid.", error: { reason: "Unauthorized", message: "The access token provided is invalid." } }, 401),
    );
    await expect(run({ api_token: "bad" })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("didn't accept the API token"),
    });

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(scopes())
      .mockResolvedValueOnce(json({ code: 400, result: "This endpoint requires `store_id`!", error: { reason: "BadRequest", message: "This endpoint requires `store_id`!" } }, 400));
    await expect(run({ api_token: "account" })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("token is for your whole account"),
    });
  });
});
