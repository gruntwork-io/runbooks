import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Code, CheckCircle, SquareChevronRight } from "lucide-react"
import { CodeFileCollection } from './artifacts/code/CodeFileCollection'
import { CheckSummaryCollection } from './artifacts/checks/CheckSummaryCollection'

import { sampleCodeFileData } from './artifacts/code/sampleData'
import { sampleCheckData } from './artifacts/checks/sampleData'


const LogsTabContent = () => (
  <div className="p-4 w-full min-h-[200px]">
    <div className="text-sm text-gray-600 mb-3">
      Execution logs and deployment history
    </div>
    <div className="bg-gray-50 rounded-md p-3 font-mono text-xs text-gray-700 space-y-1">
      <div>[2025-01-27 10:30:15] Starting deployment...</div>
      <div>[2025-01-27 10:30:16] Validating configuration...</div>
      <div>[2025-01-27 10:30:17] Creating security group...</div>
      <div>[2025-01-27 10:30:18] Security group created successfully</div>
      <div>[2025-01-27 10:30:19] Applying tags...</div>
      <div>[2025-01-27 10:30:20] Deployment completed successfully</div>
    </div>
  </div>
)

interface ArtifactsContainerProps {
  className?: string;
}

export const ArtifactsContainer = ({ className = "" }: ArtifactsContainerProps) => (
  <Tabs defaultValue="code" className={className}>
    <div className="sticky top-0 z-20 bg-bg-default pt-6 translate -translate-y-6">
      <TabsList className="w-full justify-start">
        <TabsTrigger value="code" className="flex items-center gap-2">
          <Code className="size-4" />
          Code
        </TabsTrigger>
        <TabsTrigger value="checks" className="flex items-center gap-2">
          <CheckCircle className="size-4" />
          Checks
        </TabsTrigger>
        <TabsTrigger value="logs" className="flex items-center gap-2">
          <SquareChevronRight className="size-4" />
          Commands
        </TabsTrigger>
      </TabsList>
    </div>
    <div className="overflow-y-auto max-h-[calc(100vh-8rem)] -mt-5">
      <TabsContent value="code" className="mt-0 w-full">
        <CodeFileCollection data={sampleCodeFileData} />
      </TabsContent>
      <TabsContent value="checks" className="mt-0 w-full">
        <CheckSummaryCollection data={sampleCheckData} />
      </TabsContent>
      <TabsContent value="logs" className="mt-0 w-full">
        <LogsTabContent />
      </TabsContent>
    </div>
  </Tabs>
)
