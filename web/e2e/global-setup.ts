import { execSync } from "child_process";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

/** Repo root: two directories above web/e2e/ */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const SOURCE_DIRS = ["src"];
const SOURCE_FILES = [
  "index.html",
  "package.json",
  "bun.lock",
  "vite.config.ts",
  "tsconfig.json",
  "tsconfig.app.json",
  "tsconfig.node.json",
  "components.json",
];
const FINGERPRINT_FILE = ".source-fingerprint";

/**
 * Build a fingerprint of all frontend source files by hashing their
 * paths, sizes, and modification times. This is fast (no file reads)
 * and detects any edit, addition, or deletion.
 * 
 * This is useful because we can detect if the frontend has changed and
 * rebuild it if needed.
 */
function computeSourceFingerprint(webDir: string): string {
  const entries: string[] = [];

  function walkDir(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walkDir(fullPath);
      } else {
        const stat = fs.statSync(fullPath);
        const rel = path.relative(webDir, fullPath);
        entries.push(`${rel}\t${stat.size}\t${stat.mtimeMs}`);
      }
    }
  }

  for (const dir of SOURCE_DIRS) {
    const abs = path.join(webDir, dir);
    if (fs.existsSync(abs)) walkDir(abs);
  }

  for (const file of SOURCE_FILES) {
    const abs = path.join(webDir, file);
    if (fs.existsSync(abs)) {
      const stat = fs.statSync(abs);
      entries.push(`${file}\t${stat.size}\t${stat.mtimeMs}`);
    }
  }

  entries.sort();
  return crypto.createHash("sha256").update(entries.join("\n")).digest("hex");
}

/** Return true if web/dist is up-to-date with the source files. */
function isFrontendCurrent(webDir: string): boolean {
  const distDir = path.join(webDir, "dist");
  const fpFile = path.join(distDir, FINGERPRINT_FILE);

  if (!fs.existsSync(distDir) || !fs.existsSync(fpFile)) return false;

  const stored = fs.readFileSync(fpFile, "utf-8").trim();
  const current = computeSourceFingerprint(webDir);
  return stored === current;
}

/**
 * Playwright global setup: ensures the Go binary is built before tests run.
 *
 * This mirrors `task build` but calls `go build` directly so there's no
 * dependency on the `task` CLI being installed.
 */
export default function globalSetup() {
  const binaryPath = path.join(REPO_ROOT, "runbooks");
  const webDir = path.join(REPO_ROOT, "web");
  const distDir = path.join(webDir, "dist");

  if (isFrontendCurrent(webDir)) {
    console.log("[global-setup] Frontend is up-to-date, skipping build.");
  } else {
    console.log("[global-setup] Frontend sources changed, rebuilding...");
    execSync("bun install && bun run build", { cwd: webDir, stdio: "inherit" });
    const fingerprint = computeSourceFingerprint(webDir);
    fs.writeFileSync(path.join(distDir, FINGERPRINT_FILE), fingerprint + "\n");
  }

  // Build the Go binary
  console.log("[global-setup] Building Go binary...");
  execSync("go build -o runbooks .", { cwd: REPO_ROOT, stdio: "inherit" });

  if (!fs.existsSync(binaryPath)) {
    throw new Error(`Expected binary at ${binaryPath} but it was not found`);
  }

  console.log("[global-setup] Binary ready at", binaryPath);
}
