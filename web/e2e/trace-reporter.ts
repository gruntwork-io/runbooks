/**
 * Custom Playwright reporter that prints copy-pasteable commands to download
 * and view traces when tests fail in CI.
 */
import type {
  Reporter,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";

class TraceReporter implements Reporter {
  private failures: { title: string; traceDir: string }[] = [];

  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status !== "failed" && result.status !== "timedOut") return;

    // Find trace attachment
    const trace = result.attachments.find(
      (a) => a.name === "trace" && a.path,
    );
    if (!trace?.path) return;

    this.failures.push({
      title: test.titlePath().slice(1).join(" › "),
      traceDir: trace.path,
    });
  }

  onEnd() {
    if (this.failures.length === 0) return;

    const isCI = !!process.env.CI;
    const repo = process.env.GITHUB_REPOSITORY ?? "gruntwork-io/runbooks";
    const runId = process.env.GITHUB_RUN_ID ?? "<run-id>";

    console.log("\n╔══════════════════════════════════════════════════╗");
    console.log("║           🔍 FAILED TEST TRACES                 ║");
    console.log("╠══════════════════════════════════════════════════╣\n");

    if (isCI) {
      // Single contiguous block: download artifact then open every trace.
      const lines = [
        `gh run download ${runId} -R ${repo} -n playwright-results`,
        ...this.failures.map(
          ({ title, traceDir }) =>
            `\n# ${title}\nnpx playwright show-trace ${traceDir}`,
        ),
      ];
      console.log(lines.join(" && \\\n") + "\n");
    } else {
      // Local: traces already on disk, just show-trace commands.
      const lines = this.failures.map(
        ({ title, traceDir }) =>
          `# ${title}\nnpx playwright show-trace ${traceDir}`,
      );
      console.log(lines.join(" && \\\n\n") + "\n");
    }

    console.log("══════════════════════════════════════════════════\n");
  }
}

export default TraceReporter;
