import { describe, it, expect, vi, afterEach } from "vitest";
import Printful, { ACCOUNT_TOKEN_MESSAGE } from "../../functions/lib/printful";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Printful errors", () => {
  it("explains what to do about an account-wide token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 400,
          result: "This endpoint requires `store_id`!",
          error: { reason: "BadRequest", message: "This endpoint requires `store_id`!" },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(new Printful("token").listSyncProducts(100, 0)).rejects.toMatchObject({
      status: 400,
      message: ACCOUNT_TOKEN_MESSAGE,
    });
  });

  it("passes other Printful errors through", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 401,
          result: "The access token provided is invalid.",
          error: { reason: "Unauthorized", message: "The access token provided is invalid." },
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(new Printful("token").listSyncProducts(100, 0)).rejects.toMatchObject({
      status: 401,
      message: "The access token provided is invalid.",
    });
  });
});
