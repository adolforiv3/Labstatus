// Push notifications only - this service worker deliberately does no
// caching/offline work, just receiving pushes and handling clicks on them.
self.addEventListener("push", (event) => {
  let data = { title: "Lab Status Board", body: "" };
  try {
    data = event.data ? event.data.json() : data;
  } catch {
    // ignore malformed payloads rather than crash the worker
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Lab Status Board", {
      body: data.body || "",
      icon: "/icon.png",
      data: { url: data.url || "/" },
      tag: data.tag || undefined,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(url) && "focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
