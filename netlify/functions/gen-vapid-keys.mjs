// TEMPORARY - generates a fresh VAPID keypair for Web Push setup.
// Delete this file once the keys are copied into env vars; it has no
// auth and shouldn't stay deployed.
import webpush from "web-push";

export default async () => {
  const keys = webpush.generateVAPIDKeys();
  return new Response(JSON.stringify(keys, null, 2), { headers: { "content-type": "application/json" } });
};
