import type { GateRoute } from "./route-store";

const page = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font: 15px/1.6 -apple-system, system-ui, sans-serif;
    display: grid; place-items: center; min-height: 100vh; margin: 0;
    background: light-dark(#f6f5f2, #171614);
    color: light-dark(#2b2a27, #d9d6cf);
  }
  main { max-width: 26rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.1rem; font-weight: 600; margin: 0 0 .5rem; }
  p { margin: .25rem 0; color: light-dark(#6d6a63, #96938b); }
  code { font-family: ui-monospace, monospace; font-size: .85em; }
  .spin {
    width: 1.4rem; height: 1.4rem; margin: 0 auto 1rem;
    border: 2px solid light-dark(#d8d5cd, #3a3833); border-top-color: #4d7c4d;
    border-radius: 50%; animation: spin .8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  ul { list-style: none; padding: 0; text-align: left; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;

/** Served while a known route has no living upstream; polls until it does. */
export function holdingPage(route: GateRoute): string {
  return page(
    "Starting…",
    `<div class="spin"></div>
<h1>Waking <code>${escapeHtml(route.name)}</code></h1>
<p>Silvic is starting this environment. The page reloads by itself.</p>
<script>
  const poll = async () => {
    try {
      const reply = await fetch("/__silvic/route-status", { cache: "no-store" });
      const status = await reply.json();
      if (status.ready) { location.reload(); return; }
    } catch {}
    setTimeout(poll, 1200);
  };
  poll();
</script>`,
  );
}

/** Served while Silvic repairs a known broken upstream. */
export function recoveryPage(route: GateRoute): string {
  return page(
    "Repairing…",
    `<div class="spin"></div>
<h1>Repairing <code>${escapeHtml(route.name)}</code></h1>
<p>Silvic is rebuilding the preview cache. The page reloads by itself.</p>
<script>
  const poll = async () => {
    try {
      const reply = await fetch("/__silvic/route-status", { cache: "no-store" });
      const status = await reply.json();
      if (status.ready) { location.reload(); return; }
    } catch {}
    setTimeout(poll, 1200);
  };
  poll();
</script>`,
  );
}

export function unknownRoutePage(
  host: string,
  routes: readonly GateRoute[],
): string {
  const known = routes
    .map(
      (route) =>
        `<li><a href="https://${route.name}.localhost/"><code>${escapeHtml(route.name)}.localhost</code></a></li>`,
    )
    .join("");
  return page(
    "Unknown environment",
    `<h1><code>${escapeHtml(host)}</code> is not registered</h1>
<p>Silvic has not published this environment${routes.length ? ", but it serves these:" : " yet."}</p>
${known ? `<ul>${known}</ul>` : ""}`,
  );
}

export function upstreamFailedPage(route: GateRoute): string {
  return page(
    "Preview unavailable",
    `<h1><code>${escapeHtml(route.name)}</code> stopped answering</h1>
<p>The dev server closed the connection. Silvic is waking it back up; reload in a moment.</p>`,
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
