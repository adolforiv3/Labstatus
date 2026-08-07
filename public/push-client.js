// Shared Web Push subscribe/unsubscribe helper, loaded by both task.html
// and admin.html. Assumes an `api(action, extra)` function already exists
// in the page (both pages define one with the same shape - POST to the
// stations function).

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window;
}

async function getPushSubscription() {
  if (!(await pushSupported())) return null;
  const reg = await navigator.serviceWorker.register("/sw.js");
  return reg.pushManager.getSubscription();
}

// Returns true if this device is already subscribed to the given scope.
// Scope-specificity is tracked separately in sessionStorage (a single
// browser subscription endpoint can be registered against multiple
// scopes server-side, e.g. one device subscribed to two different tasks).
function isPushEnabled(scope) {
  return sessionStorage.getItem("push:" + scope) === "1";
}

async function enablePush(scope, authExtra) {
  const vapidRes = await fetch("/.netlify/functions/push");
  const vapidData = await vapidRes.json().catch(() => ({}));
  if (!vapidRes.ok || !vapidData.publicKey) {
    throw new Error(vapidData.error || "push notifications are not set up on this deploy yet");
  }

  const reg = await navigator.serviceWorker.register("/sw.js");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("notification permission was not granted");

  let subscription = await reg.pushManager.getSubscription();
  if (!subscription) {
    subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidData.publicKey),
    });
  }

  const res = await fetch("/.netlify/functions/push", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "subscribe", scope, subscription: subscription.toJSON(), ...authExtra }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "failed to subscribe");
  sessionStorage.setItem("push:" + scope, "1");
}

async function disablePush(scope) {
  const sub = await getPushSubscription();
  sessionStorage.removeItem("push:" + scope);
  if (!sub) return;
  await fetch("/.netlify/functions/push", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "unsubscribe", endpoint: sub.endpoint }),
  }).catch(() => {});
  // Deliberately not calling sub.unsubscribe() here - the same browser
  // push subscription may still be registered against other scopes
  // (e.g. another task) that this call shouldn't tear down.
}
