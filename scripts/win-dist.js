/**
 * Windows builds often fail extracting winCodeSign because the archive
 * contains macOS symlinks and Windows blocks symlink creation without
 * Developer Mode / Admin. Skip code-signing tooling for local NSIS builds.
 */
process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
process.env.CSC_IDENTITY_FILE = "";

const { spawnSync } = require("child_process");

const result = spawnSync(
  "npx",
  [
    "electron-builder",
    "--win",
    "--config.win.signAndEditExecutable=false",
  ],
  {
    stdio: "inherit",
    shell: true,
    env: process.env,
  }
);

process.exit(result.status === null ? 1 : result.status);
