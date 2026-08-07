import { loadHistory } from "./lib/state.mjs";
import { withErrorBoundary } from "./lib/http.mjs";
import { attachmentsStore } from "./lib/stores.mjs";
import { buildZip } from "./lib/zip.mjs";

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtDuration(ms) {
  if (ms == null) return "n/a";
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}h ${pad(m)}m ${pad(s)}s` : `${m}m ${pad(s)}s`;
}

function attachmentsOf(entry) {
  return entry.updates.filter((u) => u.attachment).map((u) => u.attachment);
}

// Renders one completed task as a standalone, self-contained HTML document
// - readable directly, and printable to PDF from the browser - so it can be
// handed off to engineering with the full note timeline and links back to
// every uploaded attachment (attachments stay served from this same site,
// not embedded, since some can be several MB). Individual files stay
// downloadable one at a time via their own links; a "download all" zip
// link is added up top whenever there's more than one file, so whoever's
// handed the report isn't stuck clicking through each one separately.
function renderReport(entry, origin) {
  const attachments = attachmentsOf(entry);
  const downloadAllHtml =
    attachments.length > 1
      ? `<a class="download-all" href="${origin}/.netlify/functions/report?id=${encodeURIComponent(entry.id)}&format=zip">⬇ Download all ${attachments.length} files (.zip)</a>`
      : "";

  const updatesHtml = entry.updates.length
    ? entry.updates
        .map(
          (u) => `
        <div class="entry">
          <div class="entry-head">
            <span class="entry-status">${esc(u.status)}</span>
            <span class="entry-time">${esc(new Date(u.ts).toLocaleString())}</span>
          </div>
          <div class="entry-note">${esc(u.note)}</div>
          ${
            u.attachment
              ? `<div class="entry-attachment"><a href="${origin}/.netlify/functions/attachments?key=${encodeURIComponent(u.attachment.key)}">📎 ${esc(u.attachment.filename)}</a> (${Math.round((u.attachment.size || 0) / 1024)} KB)</div>`
              : ""
          }
        </div>`
        )
        .join("")
    : `<p class="empty">No update notes were recorded.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Task Report — ${esc(entry.stationName)} — ${esc(entry.taskLabel)}</title>
<style>
  body{ font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; color:#1d1d1f; max-width:800px; margin:40px auto; padding:0 24px; line-height:1.5; }
  h1{ font-size:22px; margin-bottom:4px; }
  .sub{ color:#6e6e73; font-size:14px; margin-bottom:24px; }
  .meta-grid{ display:grid; grid-template-columns:1fr 1fr; gap:12px 24px; margin-bottom:28px; padding:16px 20px; background:#f5f5f7; border-radius:12px; }
  .meta-item .label{ font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:#6e6e73; font-weight:600; }
  .meta-item .value{ font-size:15px; font-weight:600; }
  h2{ font-size:16px; margin:28px 0 12px; }
  .entry{ border:1px solid #e5e5e7; border-radius:10px; padding:12px 14px; margin-bottom:10px; }
  .entry-head{ display:flex; justify-content:space-between; font-size:12px; color:#6e6e73; margin-bottom:6px; text-transform:uppercase; letter-spacing:.02em; font-weight:600; }
  .entry-note{ font-size:14px; }
  .entry-attachment{ margin-top:8px; font-size:13px; }
  .entry-attachment a{ color:#5e5ce6; }
  .empty{ color:#6e6e73; font-size:14px; }
  .download-all{
    display:inline-block; margin-top:14px; padding:10px 18px; border-radius:10px;
    background:#5e5ce6; color:#fff; text-decoration:none; font-size:14px; font-weight:600;
  }
  @media print{ .download-all{ display:none; } body{ margin:0; } }
</style>
</head>
<body>
  <h1>${esc(entry.taskLabel)}</h1>
  <div class="sub">${esc(entry.stationName)} · Completed ${esc(new Date(entry.completedAt).toLocaleString())}</div>
  ${downloadAllHtml}

  <div class="meta-grid">
    <div class="meta-item"><div class="label">Station</div><div class="value">${esc(entry.stationName)}</div></div>
    <div class="meta-item"><div class="label">Zone</div><div class="value">${esc(entry.zone || "n/a")}</div></div>
    <div class="meta-item"><div class="label">Completed by</div><div class="value">${esc(entry.ownerName)}</div></div>
    <div class="meta-item"><div class="label">Kit</div><div class="value">${esc(entry.kit || "n/a")}</div></div>
    <div class="meta-item"><div class="label">Started</div><div class="value">${esc(entry.startedAt ? new Date(entry.startedAt).toLocaleString() : "n/a")}</div></div>
    <div class="meta-item"><div class="label">Task time</div><div class="value">${fmtDuration(entry.taskDurationMs)}</div></div>
    <div class="meta-item"><div class="label">Review time</div><div class="value">${fmtDuration(entry.reviewDurationMs)}</div></div>
  </div>

  <h2>Update &amp; note history</h2>
  ${updatesHtml}
</body>
</html>`;
}

export default withErrorBoundary(async (req) => {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return new Response("missing id", { status: 400 });

  const history = await loadHistory();
  const entry = history.find((h) => h.id === id);
  if (!entry) return new Response("report not found", { status: 404 });

  if (url.searchParams.get("format") === "zip") {
    const attachments = attachmentsOf(entry);
    if (!attachments.length) return new Response("no attachments to bundle", { status: 404 });

    const store = attachmentsStore();
    const files = [];
    for (const att of attachments) {
      const result = await store.get(att.key, { type: "arrayBuffer" });
      if (result) files.push({ name: att.filename, data: Buffer.from(result) });
    }
    if (!files.length) return new Response("no attachments found", { status: 404 });

    const zip = buildZip(files);
    const zipFilename = `task-files-${entry.stationName}-${entry.completedAt.slice(0, 10)}.zip`.replace(/[^a-z0-9.\-]+/gi, "-");
    return new Response(zip, {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${zipFilename}"`,
      },
    });
  }

  // Served inline (not as an attachment download) so the link opens as a
  // normal page to read through first - the actual file downloads (the
  // report's own individual attachment links, or the "download all" zip)
  // happen from within that view, not as the first click.
  const html = renderReport(entry, url.origin);
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});
