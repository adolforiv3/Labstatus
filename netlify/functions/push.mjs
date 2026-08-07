import { json, withErrorBoundary } from "./lib/http.mjs";
import { publicVapidKey, addSubscription, removeSubscription } from "./lib/push.mjs";
import { resolveAdminToken, resolveUserToken } from "./lib/auth.mjs";

function isAdmin(body) {
  return !!body.adminToken && resolveAdminToken(body.adminToken);
}
function isUser(body) {
  return isAdmin(body) || (!!body.userToken && resolveUserToken(body.userToken));
}

export default withErrorBoundary(async (req) => {
  if (req.method === "GET") {
    const key = publicVapidKey();
    if (!key) return json({ error: "push notifications are not configured on this deploy yet" }, 503);
    return json({ publicKey: key });
  }

  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  const body = await req.json().catch(() => ({}));
  const action = body.action;

  if (action === "subscribe") {
    const { subscription, scope } = body; // scope: "admin" or a taskId string
    if (!subscription || !subscription.endpoint) return json({ error: "invalid subscription" }, 400);
    if (!scope) return json({ error: "scope required" }, 400);

    // Admin-scoped subscriptions need an admin session; task-scoped ones
    // just need the regular user passcode (same bar as claiming/updating
    // a task in the first place).
    const authorized = scope === "admin" ? isAdmin(body) : isUser(body);
    if (!authorized) return json({ error: "passcode required" }, 401);

    await addSubscription(scope, subscription);
    return json({ ok: true });
  }

  if (action === "unsubscribe") {
    const { endpoint } = body;
    if (!endpoint) return json({ error: "endpoint required" }, 400);
    await removeSubscription(endpoint);
    return json({ ok: true });
  }

  return json({ error: "unknown action" }, 400);
});
