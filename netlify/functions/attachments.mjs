import { attachmentsStore } from "./lib/stores.mjs";
import { withErrorBoundary } from "./lib/http.mjs";

// Kept well under Netlify Functions' request body ceiling so an upload
// fails with a clear 413 instead of the platform silently truncating or
// rejecting the whole request.
const MAX_BYTES = 8 * 1024 * 1024;

export default withErrorBoundary(async (req) => {
  const url = new URL(req.url);
  const store = attachmentsStore();

  if (req.method === "GET") {
    const key = url.searchParams.get("key");
    if (!key) return new Response("missing key", { status: 400 });
    const result = await store.getWithMetadata(key, { type: "arrayBuffer" });
    if (!result) return new Response("not found", { status: 404 });
    const meta = result.metadata || {};
    return new Response(result.data, {
      status: 200,
      headers: {
        "content-type": meta.mimeType || "application/octet-stream",
        "content-disposition": `inline; filename="${(meta.filename || "file").replace(/"/g, "")}"`,
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json" },
    });
  }

  const body = await req.json().catch(() => ({}));
  const filename = (body.filename || "file").slice(0, 200);
  const mimeType = (body.mimeType || "application/octet-stream").slice(0, 100);
  const dataBase64 = body.dataBase64 || "";

  const buffer = Buffer.from(dataBase64, "base64");
  if (buffer.length === 0) {
    return new Response(JSON.stringify({ error: "empty file" }), { status: 400, headers: { "content-type": "application/json" } });
  }
  if (buffer.length > MAX_BYTES) {
    return new Response(JSON.stringify({ error: "file too large (8MB max)" }), {
      status: 413,
      headers: { "content-type": "application/json" },
    });
  }

  const key = crypto.randomUUID();
  await store.set(key, buffer, {
    metadata: { filename, mimeType, size: buffer.length, uploadedAt: new Date().toISOString() },
  });

  return new Response(JSON.stringify({ key, filename, mimeType, size: buffer.length }), {
    status: 201,
    headers: { "content-type": "application/json" },
  });
});
