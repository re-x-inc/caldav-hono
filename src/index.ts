import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { sweepAllInboxes } from "./scheduling.js";
import { storeBackend } from "./store.js";

const port = +(process.env.PORT ?? 5232);
const hostname = process.env.HOST ?? "0.0.0.0";

// Startup inbox sweep (retention); later sweeps happen on delivery.
try {
  const removed = sweepAllInboxes();
  if (removed > 0) console.log(`[caldav-hono] inbox sweep removed ${removed} expired message(s)`);
} catch (e) {
  console.error(`[caldav-hono] inbox sweep failed: ${e instanceof Error ? e.message : String(e)}`);
}

serve({ fetch: createApp().fetch, port, hostname }, (info) => {
  console.log(`caldav-hono listening on http://${info.address}:${info.port} (store=${storeBackend()})`);
});
