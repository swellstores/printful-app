import { describe, it, expect } from "vitest";
import { isUniqueViolation } from "../../functions/lib/errors";

describe("isUniqueViolation", () => {
  it("matches the validation-failure envelope", () => {
    // A validation failure throws with the errors map itself as the body.
    const err = new SwellError({
      order_id: { code: "UNIQUE", message: "Value must be unique" },
    });

    expect(isUniqueViolation(err, "order_id")).toBe(true);
  });

  it("matches the response-body envelope", () => {
    // A non-2xx response throws with the whole body, nesting the same map.
    const err = new SwellError({
      errors: { order_id: { code: "UNIQUE", message: "Value must be unique" } },
    });

    expect(isUniqueViolation(err, "order_id")).toBe(true);
  });

  it("does not match another error code", () => {
    const err = new SwellError({ errors: { order_id: { code: "REQUIRED" } } });

    expect(isUniqueViolation(err, "order_id")).toBe(false);
  });

  it("does not match a unique violation on another field", () => {
    const err = new SwellError({ errors: { external_id: { code: "UNIQUE" } } });

    expect(isUniqueViolation(err, "order_id")).toBe(false);
  });

  it("does not match an error with no structured body", () => {
    expect(isUniqueViolation(new SwellError("Bad gateway"), "order_id")).toBe(
      false,
    );
    expect(isUniqueViolation(new Error("boom"), "order_id")).toBe(false);
    expect(isUniqueViolation(undefined, "order_id")).toBe(false);
  });
});
