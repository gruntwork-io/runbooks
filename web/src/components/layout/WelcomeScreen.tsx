import { FileText, Terminal, Mouse } from 'lucide-react'

export function WelcomeScreen() {
  return (
    <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
      <div className="text-center max-w-lg mx-auto px-6">
        <img
          src="/runbooks-logo-dark-color.svg"
          alt="Gruntwork Runbooks"
          className="h-20 mx-auto mb-6"
        />
        <p className="text-gray-500 text-lg mb-10">
          Open a runbook to get started.
        </p>

        <div className="grid gap-4 text-left">
          <div className="flex items-start gap-3 p-4 rounded-lg border border-gray-200 bg-gray-50">
            <FileText className="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-gray-700">File &gt; Open Runbook</p>
              <p className="text-xs text-gray-500 mt-0.5">
                Or press <kbd className="px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 font-mono text-[10px]">&#8984;O</kbd> to open a <code className="text-[11px] bg-gray-200 px-1 rounded">.mdx</code> file
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3 p-4 rounded-lg border border-gray-200 bg-gray-50">
            <Terminal className="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-gray-700">Open from the command line</p>
              <p className="text-xs text-gray-500 mt-0.5">
                <code className="bg-gray-200 px-1.5 py-0.5 rounded font-mono text-[11px] text-gray-600">runbooks ./path/to/runbook.mdx</code>
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3 p-4 rounded-lg border border-gray-200 bg-gray-50">
            <Mouse className="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-gray-700">Drag &amp; drop</p>
              <p className="text-xs text-gray-500 mt-0.5">
                Drop a <code className="text-[11px] bg-gray-200 px-1 rounded">.mdx</code> file onto this window
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
