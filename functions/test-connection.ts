import Printful, { PrintfulError } from "./lib/printful";
import { getSettings } from "./lib/settings";

export const config: SwellConfig = {
  description: "Check the Printful API token, its store and its scopes",
  action: {},
};

// a thrown 400 shows in the admin as a red error popup, a returned message as a regular one
function fail(message: string): never {
  throw new SwellError(message, { status: 400 });
}

// The scopes the app needs, each with the grants that satisfy it: orders to
// submit them, sync_products to read the designs.
const REQUIRED_SCOPES: Record<string, string[]> = {
  orders: ["orders"],
  sync_products: ["sync_products", "sync_products/read"],
};

/**
 * Two read-only calls: the token's scopes (allowed for any token), then one
 * product from its store, which an account-wide token can't read without a
 * store id. Naming the store would need the stores_list scope, which the app
 * doesn't ask merchants for.
 */
export async function post(req: SwellRequest) {
  const settings = await getSettings(req);

  if (!settings.api_token) {
    fail("Add the Printful API token and save the settings first.");
  }

  const printful = new Printful(settings.api_token);
  let products: any;
  try {
    const scopes = await printful.request("GET", "/oauth/scopes");
    const granted = (scopes?.result?.scopes ?? []).map((s: any) => s?.scope);
    const missing = Object.keys(REQUIRED_SCOPES).filter(
      (scope) => !REQUIRED_SCOPES[scope].some((grant) => granted.includes(grant)),
    );
    if (missing.length) {
      fail(
        `Printful accepted the token, but it lacks the ${missing.map((s) => `'${s}'`).join(" and ")} scope${missing.length > 1 ? "s" : ""}. Create a token with the 'orders' (full access) and 'sync_products' scopes.`,
      );
    }
    products = await printful.request("GET", "/store/products?limit=1");
  } catch (err) {
    if (err instanceof SwellError) throw err;
    if (err instanceof PrintfulError) {
      if (err.status === 401) {
        fail(
          "Printful didn't accept the API token. Check that it was copied in full and hasn't expired or been deleted.",
        );
      }
      fail(`Printful refused the token: ${err.message}`);
    }
    fail("Couldn't reach Printful. Try again in a minute.");
  }

  const total = Number(products?.paging?.total ?? 0);
  if (!total) {
    return {
      message:
        "Connected to Printful, but the token's store has no products yet. Design them in that store in Printful, then choose Sync products now.",
    };
  }
  return {
    message: `Connected to Printful. The token's store has ${total} product${total === 1 ? "" : "s"}.`,
  };
}
