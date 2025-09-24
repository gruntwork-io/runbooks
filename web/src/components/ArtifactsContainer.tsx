import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Code, CheckCircle, SquareChevronRight } from "lucide-react"
import { CodeFileCollection } from './artifacts/code/CodeFileCollection'
import { CheckSummaryCollection } from './artifacts/checks/CheckSummaryCollection'
import { CommandSummaryCollection } from './artifacts/commands/CommandSummaryCollection'

import { sampleCodeFileData } from './artifacts/code/sampleData'
import { sampleCheckData } from './artifacts/checks/sampleData'
import { sampleCommandData } from './artifacts/commands/sampleData'


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
        <CommandSummaryCollection data={sampleCommandData} />
      </TabsContent>
    </div>
  </Tabs>
)
