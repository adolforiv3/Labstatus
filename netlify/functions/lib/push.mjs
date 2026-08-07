import webpush from "web-push";
import { pushSubscriptionsStore } from "./stores.mjs";
import { updateJSON } from "./occ.mjs";

const SUBS_KEY = "subscriptions";

const VAPID_PUBLIC_KEY = process.env.PUSH_VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.PUSH_VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.PUSH_VAPID_SUBJECT || "mailto:admin@example.com";

let configured = false;
function ensureConfigured() {
  if (configured) return true;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
  return true;
}

export function publicVapidKey() {
  return VAPID_PUBLIC_KEY || null;
}

export async function loadSubscriptions() {
  const store = pushSubscriptionsStore();
  return (await store.get(SUBS_KEY, { type: "json" })) || [];
}

// `scope` is either "admin" (notified on every task entering review) or a
// taskId string (notified on updates to that one task). One physical
// device can hold multiple subscription entries (e.g. subscribed to admin
// alerts on one browser and to a specific task on another) - de-duped by
// the push endpoint URL, which is unique per browser+origin registration.
export async function addSubscription(scope, subscription) {
  const store = pushSubscriptionsStore();
  await updateJSON(store, SUBS_KEY, async (current) => {
    const list = current || [];
    const filtered = list.filter((s) => s.subscription.endpoint !== subscription.endpoint || s.scope !== scope);
    filtered.push({ scope, subscription, createdAt: new Date().toISOString() });
    return filtered;
  });
}

export async function removeSubscription(endpoint) {
  const store = pushSubscriptionsStore();
  await updateJSON(store, SUBS_KEY, async (current) => (current || []).filter((s) => s.subscription.endpoint !== endpoint));
}

// Drops every subscription tied to a given scope - used when a task is
// completed/released/deleted, since a taskId-scoped subscription has
// nothing left to notify about once that task no longer exists.
export async function removeScope(scope) {
  const store = pushSubscriptionsStore();
  await updateJSON(store, SUBS_KEY, async (current) => (current || []).filter((s) => s.scope !== scope)).catch(() => {});
}

// Best-effort fire-and-forget notify - a push failure (expired
// subscription, browser permission revoked, etc.) should never break the
// action that triggered it. Subscriptions that come back "gone" (410) or
// "not found" (404) are pruned so the list doesn't accumulate dead
// entries forever.
export async function notifyScope(scope, payload) {
  if (!ensureConfigured()) return; // no VAPID keys configured yet - push is a no-op until they are
  const all = await loadSubscriptions();
  const targets = all.filter((s) => s.scope === scope);
  if (!targets.length) return;

  const deadEndpoints = [];
  await Promise.all(
    targets.map(async (t) => {
      try {
        await webpush.sendNotification(t.subscription, JSON.stringify(payload));
      } catch (err) {
        if (err && (err.statusCode === 410 || err.statusCode === 404)) {
          deadEndpoints.push(t.subscription.endpoint);
        } else {
          console.error("push send failed:", err && err.message ? err.message : err);
        }
      }
    })
  );

  if (deadEndpoints.length) {
    const store = pushSubscriptionsStore();
    await updateJSON(store, SUBS_KEY, async (current) => (current || []).filter((s) => !deadEndpoints.includes(s.subscription.endpoint))).catch(() => {});
  }
}
