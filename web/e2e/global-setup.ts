import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

/** Repo root: two directories above web/e2e/ */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Playwright global setup: ensures the Go binary is built before tests run.
 *
 * This mirrors `task build` but calls `go build` directly so there's no
 * dependency on the `task` CLI being installed.
 */
export default function globalSetup() {
  const binaryPath = path.join(REPO_ROOT, "runbooks");

  // Build the frontend first (required for Go embed)
  const webDir = path.join(REPO_ROOT, "web");
  const distDir = path.join(webDir, "dist");
  if (!fs.existsSync(distDir)) {
    console.log("[global-setup] Building frontend (web/dist not found)...");
    execSync("bun install && bun run build", { cwd: webDir, stdio: "inherit" });
  }

  // Build the Go binary
  console.log("[global-setup] Building Go binary...");
  execSync("go build -o runbooks .", { cwd: REPO_ROOT, stdio: "inherit" });

  if (!fs.existsSync(binaryPath)) {
    throw new Error(`Expected binary at ${binaryPath} but it was not found`);
  }

  console.log("[global-setup] Binary ready at", binaryPath);
}
