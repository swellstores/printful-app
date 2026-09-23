// Jobs are normally driven by the model schedule on date_next_attempt. This is
// the safety net for the ones whose scheduled wake-up was lost — a redeployed
// function, a dropped delivery. The grace period keeps it from racing the
// scheduler on jobs that are simply not due yet.
const OVERDUE_GRACE_MS = 5 * 60 * 1000;
const BATCH = 25;

export const config: SwellConfig = {
  description: "Re-arm Printful fulfillment jobs whose scheduled wake-up was lost",
  cron: {
    schedule: "*/10 * * * *",
  },
};

export default async function (req: SwellRequest) {
  const collection = `/apps/${req.appId}/fulfillments`;

  const overdue = await req.swell.get(collection, {
    state: { $in: ["pending", "created", "calculating"] },
    date_next_attempt: {
      $lt: new Date(Date.now() - OVERDUE_GRACE_MS).toISOString(),
    },
    limit: BATCH,
    sort: "date_next_attempt",
    fields: ["id"],
  });

  const jobs = overdue?.results ?? [];

  // Writing date_next_attempt re-arms the schedule, which is what actually runs
  // the job. The sweep itself does no Printful work.
  for (const job of jobs) {
    await req.swell.put(`${collection}/${job.id}`, {
      date_next_attempt: new Date().toISOString(),
    });
  }

  if (jobs.length > 0) {
    console.log(`Printful fulfillment sweep re-armed ${jobs.length} jobs`);
  }
}
