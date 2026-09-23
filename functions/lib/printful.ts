const API_URL = "https://api.printful.com";
const RATE_LIMIT_WINDOW_MS = 60000;

export class PrintfulError extends Error {
  status: number;
  code: string;
  retryAfter: number | null;

  constructor(
    message: string,
    status: number,
    code: string,
    retryAfter: number | null,
  ) {
    super(message);
    this.name = "PrintfulError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

// Printful allows 120 requests per 60s across the whole token, dropping to 5
// per 60s for a cart over 100 units, and checkout quoting shares that budget
// with the catalog sync. The response header is the only forward-looking
// signal available, so the last one seen in this isolate is kept here for the
// checkout path to read before it spends a request. One deployed script serves
// every store with the app installed, so a reading is filed under the budget it
// was taken from rather than in a single shared value.
const rateLimits = new Map<string, { remaining: number; at: number }>();

const MAX_RATE_LIMIT_KEYS = 200;

/** FNV-1a. Only keeps the raw token out of a module-scope map key. */
function hash(value: string): string {
  let h = 0x811c9dc5;

  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }

  return (h >>> 0).toString(36);
}

/**
 * Identifies the budget a reading belongs to. Printful counts per token, so the
 * token alone is the key: one account-level token used against two Printful
 * store ids spends one budget, and keying by store as well would file the two
 * halves separately and let the app walk into a 429 it could have predicted.
 */
export function rateLimitKey(token: string): string {
  return hash(token);
}

function recordRateLimit(key: string, remaining: number): void {
  if (rateLimits.size >= MAX_RATE_LIMIT_KEYS) {
    rateLimits.delete(rateLimits.keys().next().value as string);
  }

  rateLimits.set(key, { remaining, at: Date.now() });
}

export function getRateLimitRemaining(key: string): number | null {
  const entry = rateLimits.get(key);

  if (!entry || Date.now() - entry.at > RATE_LIMIT_WINDOW_MS) {
    return null;
  }
  return entry.remaining;
}

function toPrintfulError(response: Response, text: string): PrintfulError {
  const contentType = response.headers.get("content-type") || "";
  const retryAfter = Number(response.headers.get("retry-after")) || null;

  let message = text.slice(0, 300) || response.statusText;
  let code = String(response.status);

  try {
    const body = JSON.parse(text);

    // v2 is inconsistent by endpoint, not by version: shipping rates and some
    // catalog operations answer with RFC 9457, while order, shipment and
    // webhook operations still answer with the legacy envelope. Branch on the
    // content type rather than on the path.
    if (contentType.includes("application/problem+json")) {
      message = [body.title, body.detail].filter(Boolean).join(" - ") || message;
      code = body.type || code;
    } else {
      message =
        body.error?.message ||
        body.error?.reason ||
        (typeof body.result === "string" ? body.result : "") ||
        message;
      code = body.error?.reason || String(body.code ?? code);
    }
  } catch {
    // Non-JSON body (gateway HTML, empty 502) — keep the raw text.
  }

  return new PrintfulError(message, response.status, code, retryAfter);
}

function withQuery(path: string, query: Record<string, string | number>) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    params.set(key, String(value));
  }

  return `${path}?${params.toString()}`;
}

export interface PrintfulRate {
  shipping: string;
  shipping_method_name?: string;
  rate: string | number;
  currency?: string;
  min_delivery_days?: number;
  max_delivery_days?: number;
}

export default class Printful {
  #token: string;
  #storeId: string | undefined;
  #signal: AbortSignal | undefined;
  #rateLimitKey: string;

  constructor(token: string, storeId?: string, signal?: AbortSignal) {
    this.#token = token;
    // Only account-level tokens accept a store header; sending it with a
    // store-level token is rejected.
    this.#storeId = storeId || undefined;
    this.#signal = signal;
    this.#rateLimitKey = rateLimitKey(token);
  }

  async request(method: string, path: string, body?: object): Promise<any> {
    const headers = new Headers({
      Authorization: `Bearer ${this.#token}`,
      Accept: "application/json",
    });

    if (this.#storeId) {
      headers.set("X-PF-Store-Id", this.#storeId);
    }

    if (body !== undefined) {
      headers.set("Content-Type", "application/json");
    }

    const response = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: this.#signal,
    });

    // Guard on the header itself: it is absent from gateway errors and from the
    // endpoints that never send it, and `Number(null)` is a finite 0, which
    // would record "no quota left" and park checkout on the fallback rate.
    const header = response.headers.get("x-ratelimit-remaining");
    const remaining = header ? Number(header) : NaN;

    if (Number.isFinite(remaining)) {
      recordRateLimit(this.#rateLimitKey, remaining);
    }

    const text = await response.text();

    if (!response.ok) {
      throw toPrintfulError(response, text);
    }

    return text ? JSON.parse(text) : null;
  }

  listCatalogProducts(limit: number, offset: number) {
    return this.request("GET", withQuery("/v2/catalog-products", { limit, offset }));
  }

  listCatalogVariants(productId: number, limit: number, offset: number) {
    return this.request(
      "GET",
      withQuery(`/v2/catalog-products/${productId}/catalog-variants`, {
        limit,
        offset,
      }),
    );
  }

  listCatalogPrices(productId: number, limit: number, offset: number) {
    return this.request(
      "GET",
      withQuery(`/v2/catalog-products/${productId}/prices`, { limit, offset }),
    );
  }

  getShippingRates(body: object): Promise<{ data: PrintfulRate[] }> {
    return this.request("POST", "/v2/shipping-rates", body);
  }

  /** Returns null when no order carries this external id yet. */
  async getOrderByExternalId(externalId: string) {
    try {
      const result = await this.request("GET", `/v2/orders/@${externalId}`);
      return result?.data ?? null;
    } catch (err) {
      if (err instanceof PrintfulError && err.status === 404) {
        return null;
      }
      throw err;
    }
  }

  async createOrder(body: object) {
    const result = await this.request("POST", "/v2/orders", body);
    return result?.data ?? null;
  }

  /** Charges the Printful account. Never call this outside `canFulfillLive`. */
  async confirmOrder(externalId: string) {
    // Printful rejects a request body on this endpoint.
    const result = await this.request(
      "POST",
      `/v2/orders/@${externalId}/confirmation`,
    );
    return result?.data ?? null;
  }

  async listShipments(printfulOrderId: string) {
    const result = await this.request(
      "GET",
      `/v2/orders/${printfulOrderId}/shipments`,
    );
    return result?.data ?? [];
  }

  /**
   * Destructive singleton: one webhook configuration exists per token, and
   * registering replaces the previous one and rotates its key pair. The
   * `secret_key` in the response is shown once.
   */
  async createWebhook(body: object) {
    const result = await this.request("POST", "/v2/webhooks", body);
    // Webhook endpoints answer with {code, result, extra}, not {data}.
    return result?.result ?? result?.data ?? null;
  }
}
