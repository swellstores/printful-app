import Printful, { PrintfulError } from "./lib/printful";
import { getSettings, PrintfulSettings } from "./lib/settings";
import { canFulfillLive } from "./lib/env";
import { getVariantLinks, toOrderItems, toRecipient } from "./lib/mapping";
import { toPrintfulShipping } from "./lib/rates";
import {
  FAILED_MESSAGE,
  FINISHED_STATUSES,
  SHIPPED_STATUSES,
  recordShipments,
} from "./lib/tracking";

const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_SECONDS = 30;
const MAX_BACKOFF_SECONDS = 3600;

// How often a confirmed order is checked for shipments and failures.
const TRACK_INTERVAL_SECONDS = 600;

const HOLD_MESSAGE =
  "Held as a draft: live fulfillment is off, or this is not the live environment. " +
  "Review the draft in Printful, then enable live fulfillment and set this job back to Pending.";

export const config: SwellConfig = {
  description:
    "Advance a Printful fulfillment job: create the draft, wait for costs, confirm, then track it until it ships",
  model: {
    events: ["fulfillment.created", "fulfillment.updated"],
    schedule: { formula: "date_next_attempt" },
  },
};

function nextAttempt(attempts: number, err?: unknown): string {
  const retryAfter = err instanceof PrintfulError ? err.retryAfter : null;

  const seconds =
    retryAfter ??
    Math.min(BASE_BACKOFF_SECONDS * 2 ** attempts, MAX_BACKOFF_SECONDS);

  return new Date(Date.now() + seconds * 1000).toISOString();
}

function nextCheck(): string {
  return new Date(Date.now() + TRACK_INTERVAL_SECONDS * 1000).toISOString();
}

/** The API returns no dashboard link, so it is derived from the order id. */
function dashboardUrl(order: any): string | undefined {
  if (order?.dashboard_url) {
    return order.dashboard_url;
  }

  return order?.id
    ? `https://www.printful.com/dashboard/order/${order.id}`
    : undefined;
}

function saveJob(req: SwellRequest, job: any, values: object) {
  return req.swell.put(`/apps/${req.appId}/fulfillments/${job.id}`, values);
}

/**
 * Moves the job out of `from` before any Printful I/O runs, and reports whether
 * this invocation should carry on.
 *
 * This is a best-effort check, not a mutex. `where` filters the read the PUT
 * does first: when the stored record no longer matches, nothing is written and
 * the call answers null, so null is a reliable "did not apply". But when it does
 * match, the write goes out by record id, unconditionally — the data API has no
 * compare-and-set. Two invocations that both read this job while it still says
 * `from` therefore both match and both carry on. The window is the gap between
 * that read and the write, one round trip wide.
 *
 * That window is far shorter than the interval at which duplicate deliveries
 * actually arrive — a redelivered event or a scheduled tick is seconds to minutes
 * behind, not microseconds — so this collapses ordinary duplicates. It does not
 * close true concurrency.
 *
 * The durable guarantee against a second real order would have to come from
 * Printful rejecting a `POST /orders` that carries an `external_id` it
 * already holds. Whether it does is unverified. Until
 * that is confirmed, the residual race here is the residual race on charging.
 *
 * The claim also moves `date_next_attempt` forward, which suppresses the echo
 * of its own write and leaves a lease: an invocation killed at the 10s limit is
 * picked up again by the schedule rather than parked forever.
 *
 * Separately, a job already in `calculating` claims itself, since the state does
 * not change, so two invocations can both reach the confirmation call. That path
 * only ever re-confirms the one order the create path produced — Printful
 * rejects the second confirmation — so it cannot produce a second charge.
 */
async function claim(req: SwellRequest, job: any, from: string, to: string) {
  const attempts = job.attempts ?? 0;

  const claimed = await saveJob(req, job, {
    where: { state: from },
    state: to,
    attempts,
    date_next_attempt: nextAttempt(attempts),
  });

  return Boolean(claimed);
}

function mirrorOrder(req: SwellRequest, orderId: string, values: object) {
  return req.swell.put(`/orders/${orderId}`, req.appValues(values));
}

async function fail(
  req: SwellRequest,
  job: any,
  message: string,
  orderValues: object = {},
) {
  await saveJob(req, job, {
    state: "failed",
    last_error: message,
    date_next_attempt: null,
  });

  await mirrorOrder(req, job.order_id, {
    submit_state: "failed",
    last_error: message,
    ...orderValues,
  });
}

async function createDraft(req: SwellRequest, printful: Printful, job: any) {
  const order = await req.swell.get("/orders/{id}", { id: job.order_id });

  if (!order) {
    return fail(req, job, "Swell order no longer exists");
  }

  const links = await getVariantLinks(req, order.items ?? []);
  const orderItems = toOrderItems(order.items ?? [], links);

  if (orderItems.length === 0) {
    return fail(req, job, "No order item is linked to a Printful product");
  }

  // Adopting an existing order by external_id covers the pass that posted this
  // order and lost the response. It runs here, immediately before the create,
  // rather than at the top of the function: everything above is Swell reads and
  // pure mapping, and hoisting it makes the gap between "no order exists" and
  // "create one" as narrow as it can be made. Narrow is all it is — nothing
  // stops a concurrent invocation from reading "none" inside the same gap. See
  // the note on `claim` above.
  let draft = await printful.getOrderByExternalId(job.external_id);

  if (!draft) {
    draft = await printful.createOrder({
      external_id: job.external_id,
      shipping: toPrintfulShipping(order.shipping?.service) ?? undefined,
      recipient: toRecipient(order.shipping, order.email),
      items: orderItems,
    });
  }

  await saveJob(req, job, {
    state: "created",
    printful_order_id: String(draft?.id ?? ""),
    attempts: 0,
    last_error: null,
    date_next_attempt: nextAttempt(0),
  });

  await mirrorOrder(req, job.order_id, {
    printful_order_id: String(draft?.id ?? ""),
    printful_status: draft?.status,
    dashboard_url: dashboardUrl(draft),
    submit_state: "created",
    last_error: null,
  });
}

async function advanceDraft(
  req: SwellRequest,
  printful: Printful,
  settings: PrintfulSettings,
  job: any,
) {
  const draft = await printful.getOrderByExternalId(job.external_id);

  if (!draft) {
    // The draft was deleted at Printful. Fall back to pending so the next pass
    // recreates it.
    return saveJob(req, job, {
      state: "pending",
      date_next_attempt: nextAttempt(job.attempts ?? 0),
    });
  }

  const status = draft.costs?.calculation_status;

  if (status === "failed") {
    return fail(req, job, "Printful could not calculate the costs of this order");
  }

  if (status !== "done") {
    const attempts = (job.attempts ?? 0) + 1;

    if (attempts >= MAX_ATTEMPTS) {
      return fail(req, job, "Printful never finished calculating this order");
    }

    return saveJob(req, job, {
      state: "calculating",
      attempts,
      date_next_attempt: nextAttempt(attempts),
    });
  }

  if (!canFulfillLive(req, settings)) {
    // Confirmation is the charge point, so a draft that cannot be confirmed is
    // parked with no next attempt. Nothing wakes it until a person acts.
    return saveJob(req, job, {
      state: "calculating",
      date_next_attempt: null,
      last_error: HOLD_MESSAGE,
    });
  }

  const confirmed = await printful.confirmOrder(job.external_id);

  // Confirmed orders are checked for shipments and failures until they ship
  await saveJob(req, job, {
    state: "confirmed",
    printful_status: confirmed?.status ?? "pending",
    attempts: 0,
    last_error: null,
    date_next_attempt: nextCheck(),
  });

  await mirrorOrder(req, job.order_id, {
    printful_order_id: String(confirmed?.id ?? job.printful_order_id ?? ""),
    printful_status: confirmed?.status ?? "pending",
    dashboard_url: dashboardUrl(confirmed ?? draft),
    confirmed_at: new Date().toISOString(),
    submit_state: "confirmed",
    last_error: null,
  });
}

/**
 * Checks a confirmed order: adds shipments that have shipped to the Swell
 * order, and fails the job if Printful rejected it. Printful can reject an
 * order after confirmation, when it validates the print files. The order's
 * status is only written when it changes, so an order in production is not
 * rewritten every check.
 */
async function track(req: SwellRequest, printful: Printful, job: any) {
  const order = await printful.getOrderByExternalId(job.external_id);

  if (!order) {
    return saveJob(req, job, {
      date_next_attempt: null,
      last_error: "The Printful order no longer exists",
    });
  }

  if (order.status === "failed") {
    return fail(req, job, FAILED_MESSAGE, { printful_status: "failed" });
  }

  if (SHIPPED_STATUSES.has(order.status)) {
    await recordShipments(
      req,
      job.order_id,
      await printful.listShipments(String(order.id)),
    );
  }

  await saveJob(req, job, {
    printful_status: order.status,
    last_error: null,
    date_next_attempt: FINISHED_STATUSES.has(order.status) ? null : nextCheck(),
  });

  if (order.status !== job.printful_status) {
    await mirrorOrder(req, job.order_id, { printful_status: order.status });
  }
}

async function backOff(req: SwellRequest, job: any, err: unknown) {
  const attempts = (job.attempts ?? 0) + 1;
  const message = err instanceof Error ? err.message : String(err);

  if (attempts >= MAX_ATTEMPTS) {
    return fail(req, job, message);
  }

  await saveJob(req, job, {
    attempts,
    last_error: message,
    date_next_attempt: nextAttempt(attempts, err),
  });
}

export default async function (req: SwellRequest) {
  const job = req.data;

  if (job.state === "failed") {
    return;
  }

  const dueAt = job.date_next_attempt ? Date.parse(job.date_next_attempt) : NaN;

  // Setting a job back to Pending with no attempt date is the documented
  // operator retry, and it runs immediately.
  const manualRetry = job.state === "pending" && !job.date_next_attempt;

  // Otherwise: no attempt date means the job is parked, and a future one means
  // the schedule has not come round yet. Either way this delivery is only the
  // echo of a write, and acting on it would double-poll Printful.
  if (!manualRetry && (!Number.isFinite(dueAt) || dueAt - Date.now() > 5000)) {
    return;
  }

  // A job retried by hand still carries the attempt count that made it give up,
  // so the counter is reset before anything reads it. Without this the first
  // transport error takes the job straight back to failed. The claim below
  // persists it.
  if (manualRetry) {
    job.attempts = 0;
  }

  const settings = await getSettings(req);

  if (!settings.api_token) {
    return;
  }

  const printful = new Printful(settings.api_token);

  if (job.state === "confirmed") {
    if (!(await claim(req, job, "confirmed", "confirmed"))) {
      return;
    }

    try {
      await track(req, printful, job);
    } catch (err) {
      // The order is already in production: an error checking on it is only
      // reported, and the next check tries again. It must not fail the job.
      await saveJob(req, job, {
        last_error: err instanceof Error ? err.message : String(err),
        date_next_attempt: nextCheck(),
      });
    }

    return;
  }

  try {
    if (job.state === "pending") {
      // A claim that does not apply means another invocation is already
      // creating this order. Creating it twice is two real Printful orders.
      if (!(await claim(req, job, "pending", "created"))) {
        return;
      }

      await createDraft(req, printful, job);
    } else {
      if (!(await claim(req, job, job.state, "calculating"))) {
        return;
      }

      await advanceDraft(req, printful, settings, job);
    }
  } catch (err) {
    // Never throw. A retried delivery would re-enter the create path on top of
    // this job's own backoff, and a retried create is a duplicate Printful
    // order — and eventually a duplicate charge.
    await backOff(req, job, err);
  }
}
