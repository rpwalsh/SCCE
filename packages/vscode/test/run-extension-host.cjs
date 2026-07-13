const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runTests, runVSCodeCommand } = require("@vscode/test-electron");

const VSCODE_VERSION = "1.96.4";
const INHERITED_HOST_VARIABLES = [
  "ELECTRON_RUN_AS_NODE",
  "VSCODE_CODE_CACHE_PATH",
  "VSCODE_CRASH_REPORTER_PROCESS_TYPE",
  "VSCODE_CWD",
  "VSCODE_ESM_ENTRYPOINT",
  "VSCODE_HANDLES_UNCAUGHT_ERRORS",
  "VSCODE_IPC_HOOK",
  "VSCODE_NLS_CONFIG",
  "VSCODE_PID"
];

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, "host-driver");
  const extensionTestsPath = path.resolve(__dirname, "extension-host.cjs");
  const packagePath = path.resolve(__dirname, "..", "..", "..", "artifacts", "scce-vscode.vsix");
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "scce-vscode-host-"));
  const userDataDir = path.join(workspacePath, ".user-data");
  const extensionsDir = path.join(workspacePath, ".extensions");
  const inheritedHostEnvironment = new Map();

  try {
    for (const name of INHERITED_HOST_VARIABLES) {
      if (process.env[name] !== undefined) inheritedHostEnvironment.set(name, process.env[name]);
      delete process.env[name];
    }
    if (!fs.existsSync(packagePath)) throw new Error(`packaged extension not found at ${packagePath}`);

    const installation = await runVSCodeCommand([
      "--install-extension",
      packagePath,
      "--force",
      `--extensions-dir=${extensionsDir}`,
      `--user-data-dir=${userDataDir}`
    ], { version: VSCODE_VERSION });
    if (installation.stdout) process.stdout.write(installation.stdout);
    if (installation.stderr) process.stderr.write(installation.stderr);

    await runTests({
      version: VSCODE_VERSION,
      extensionDevelopmentPath,
      extensionTestsPath,
      extensionTestsEnv: {
        SCCE_VSCODE_INSTALLED_ROOT: extensionsDir
      },
      launchArgs: [
        workspacePath,
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsDir}`,
        "--skip-release-notes",
        "--skip-welcome",
        "--disable-workspace-trust"
      ]
    });
  } finally {
    for (const [name, value] of inheritedHostEnvironment) process.env[name] = value;
    fs.rmSync(workspacePath, { force: true, recursive: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
