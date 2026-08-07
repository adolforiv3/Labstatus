import { attachmentsStore } from "./lib/stores.mjs";
import { withErrorBoundary } from "./lib/http.mjs";

// Kept well under Netlify Functions' request body ceiling so an upload
// fails with a clear 413 instead of the platform silently truncating or
// rejecting the whole request.
const MAX_BYTES = 8 * 1024 * 1024;

// Header values have to be Latin-1 (Node's Headers implementation throws
// "Cannot convert argument to a ByteString" otherwise) - real-world
// filenames routinely aren't. macOS screenshot names in particular embed
// U+202F (narrow no-break space) before "AM"/"PM", which is exactly what
// broke this: any filename with an em dash, curly quote, emoji, or other
// non-Latin1 character would 500 the same way. Building a plain-ASCII
// fallback for the legacy `filename=` param, plus a properly percent-
// encoded `filename*=UTF-8''...` (RFC 5987) for browsers that use it,
// gets a correct download name either way without ever touching a
// non-Latin1 byte in the raw header value.
function contentDispositionHeader(filename) {
  const safe = (filename || "file").replace(/["\r\n]/g, "").replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(filename || "file");
  return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
}

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
        "content-disposition": contentDispositionHeader(meta.filename),
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
