import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

/** Repo root: two directories above web/e2e/ */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Playwright global setup: ensures the Electron app is built before tests run.
 *
 * The `electron-vite build` command builds main, preload, and renderer in one
 * step, so a separate web build is not needed.
 */
export default function globalSetup() {
  const distDir = path.join(REPO_ROOT, "dist");

  if (fs.existsSync(path.join(distDir, "main", "index.js"))) {
    console.log("[global-setup] Electron build output found, skipping build.");
    return;
  }

  console.log("[global-setup] Building Electron app...");
  execSync("npx electron-vite build", { cwd: REPO_ROOT, stdio: "inherit" });

  console.log("[global-setup] Build complete.");
}
