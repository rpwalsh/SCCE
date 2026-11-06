# Static Pages workbench

The static export contains only the workbench HTML and its browser state module. It has no Pages Functions, hosted database, or hosted turn handler. Requests go from the browser to a loopback SCCE server; PostgreSQL, source acquisition, training, and turns stay on that device.

Build the existing UI package, then export the Pages directory:

```text
pnpm --filter @scce/ui build
node tools/export-static-workbench.mjs dist-pages
```

Publish `dist-pages/` as a static Pages asset directory. The page asks for the loopback API address and the API bearer token at connection time. The address is restricted in the browser to `127.0.0.1`, `localhost`, or `::1`; the token stays in page memory and is not stored in the static files or browser storage. The workbench state module uses a relative asset URL, so the same export works at a Pages root (`https://example.pages.dev/`) or under a subpath such as `https://rpwalsh.com/scce/`.

To stage the export under the existing `rpwalsh.com/scce/` Pages path, run from the SCCE repository root and copy the export contents to the site's `public/scce/` directory before building the site:

```powershell
pnpm --filter @scce/ui build
node tools/export-static-workbench.mjs dist-pages
New-Item -ItemType Directory -Force ..\rpwalsh_com_auction\public\scce | Out-Null
Copy-Item -Path dist-pages\* -Destination ..\rpwalsh_com_auction\public\scce -Recurse -Force
```

The copied layout is `public/scce/index.html` and `public/scce/ui/workbench-model.js`. This copies static assets only; it adds no Pages Function or hosted turn endpoint.

Before connecting, start the SCCE server bound to loopback, configure `SCCE_PAGES_ORIGINS` with the exact HTTPS origin that serves the Pages UI (for example, `https://your-project.pages.dev`), and configure its API bearer token through `SCCE_API_BEARER_TOKEN` or the local runtime configuration. For `/scce/` on rpwalsh.com, the origin value is `https://rpwalsh.com`; the path is not part of a browser origin. CORS is disabled unless an origin is explicitly configured. Cross-origin API calls require the configured bearer token even though they arrive from the same device. Private Network Access preflights are accepted only for that origin and a loopback listener. Do not bind the connector to a LAN or public address.

The build panel accepts a public GitHub repository URL and its exact 40-character commit SHA. It uses the existing bounded local acquisition/training endpoint and displays only events returned by that endpoint. Public network acquisition must already be enabled on the local server with `SCCE_ALLOW_AUTOMATIC_WEB=1`; the static page cannot enable it. A completed training receipt is a build result, not a claim that the resulting brain has passed speech, quality, or whole-machine resource qualification.
