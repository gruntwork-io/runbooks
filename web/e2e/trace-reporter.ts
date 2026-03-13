/**
 * Custom Playwright reporter that prints copy-pasteable commands to download
 * and view traces when tests fail in CI.
 */
import path from "path";

import type {
  Reporter,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";

class TraceReporter implements Reporter {
  private failures: { title: string; tracePath: string }[] = [];

  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status !== "failed" && result.status !== "timedOut") return;

    const trace = result.attachments.find(
      (a) => a.name === "trace" && a.path,
    );
    if (!trace?.path) return;

    // Extract the directory basename (e.g. "test-sample-runbooks-sampl-...-chromium")
    // and build a relative path from the download directory.
    const traceDir = path.basename(path.dirname(trace.path));

    this.failures.push({
      title: test.titlePath().slice(1).join(" › "),
      tracePath: `${traceDir}/trace.zip`,
    });
  }

  onEnd() {
    if (this.failures.length === 0) return;

    const isCI = !!process.env.CI;
    const repo = process.env.GITHUB_REPOSITORY ?? "gruntwork-io/runbooks";
    const runId = process.env.GITHUB_RUN_ID ?? "<run-id>";

    console.log("\n╔══════════════════════════════════════════════════╗");
    console.log("║           FAILED TEST TRACES                    ║");
    console.log("╠══════════════════════════════════════════════════╣\n");

    if (isCI) {
      const tmpDir = `/tmp/playwright-traces-${runId}`;
      console.log(
        `gh run download ${runId} -R ${repo} -n playwright-results --dir ${tmpDir}\n`,
      );
      for (const { title, tracePath } of this.failures) {
        console.log(`# ${title}`);
        console.log(`npx playwright show-trace ${tmpDir}/${tracePath}\n`);
      }
    } else {
      for (const { title, tracePath } of this.failures) {
        console.log(`# ${title}`);
        console.log(`npx playwright show-trace ${tracePath}\n`);
      }
    }

    console.log("══════════════════════════════════════════════════\n");
  }
}

export default TraceReporter;
