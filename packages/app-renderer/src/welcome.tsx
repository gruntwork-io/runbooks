/** What the window shows with no runbook open: how to open one. */
export function Welcome() {
  return (
    <section className="welcome" aria-labelledby="welcome-heading">
      <h1 id="welcome-heading">Open a runbook</h1>
      <p>
        Start Runbooks with a runbook on the command line: the path to its <code>runbook.mdx</code>,
        or to the folder that holds it.
      </p>
      <pre>
        <code>runbooks path/to/runbook</code>
      </pre>
    </section>
  )
}
