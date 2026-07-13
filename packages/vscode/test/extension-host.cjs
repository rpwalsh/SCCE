const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const vscode = require("vscode");

const EXTENSION_ID = "yopp-local.yopp-vscode";
const REQUIRED_COMMANDS = [
  "yopp.checkReadiness",
  "yopp.setServerToken",
  "yopp.workspace.initialize",
  "yopp.workspace.ingest",
  "yopp.workspace.applyPatchPlan",
  "yopp.project.summary",
  "yopp.workspace.ask",
  "yopp.workspace.status",
  "yopp.tasks.clear"
];

async function run() {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      postgres: { ok: true },
      serverUrl: "extension-host-smoke",
      manifest: 1
    }));
  });

  try {
    await listen(server);
    const address = server.address();
    assert.ok(address && typeof address === "object", "smoke server did not expose a TCP address");

    const configuration = vscode.workspace.getConfiguration("yopp");
    await configuration.update("serverUrl", `http://127.0.0.1:${address.port}`, vscode.ConfigurationTarget.Global);
    await configuration.update("requestTimeoutMs", 2_000, vscode.ConfigurationTarget.Global);

    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} was not discovered by the extension host`);
    const installedRoot = process.env.SCCE_VSCODE_INSTALLED_ROOT;
    assert.ok(installedRoot, "installed-extension root was not provided to the test host");
    assert.ok(isInside(installedRoot, extension.extensionPath), `extension was not loaded from the isolated VSIX installation: ${extension.extensionPath}`);
    assert.equal(extension.packageJSON.main, "./dist/extension.js");
    assert.equal(extension.packageJSON.engines.vscode, "^1.96.0");

    await extension.activate();
    assert.equal(extension.isActive, true, "extension did not activate");

    const registeredCommands = new Set(await vscode.commands.getCommands(true));
    for (const command of REQUIRED_COMMANDS) {
      assert.ok(registeredCommands.has(command), `command ${command} was not registered`);
    }

    await waitFor(() => requests.length >= 1, "activation readiness request");
    await vscode.commands.executeCommand("yopp.checkReadiness");
    await waitFor(() => requests.length >= 2, "explicit readiness request");
    await vscode.commands.executeCommand("yopp.tasks.clear");

    assert.deepEqual(requests.slice(0, 2), [
      { method: "GET", url: "/api/ready" },
      { method: "GET", url: "/api/ready" }
    ]);
  } finally {
    await close(server);
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

module.exports = { run };
