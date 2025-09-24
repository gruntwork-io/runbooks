import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Code, CheckCircle, SquareChevronRight } from "lucide-react"
import { CodeFileCollection } from './artifacts/code/CodeFileCollection'
import { sampleCodeFileData } from './artifacts/code/sampleData'
import { CheckSummary } from './artifacts/checks/CheckSummary'


const ChecksTabContent = () => {
  return (
    <div className="p-4 space-y-3">
      <CheckSummary
        status="success"
        summary="The repo github.com/acme/terraform-aws-lambda-function-url exists."
        logs={[
          '[2025-01-27 10:30:15] Checking repository existence...',
          '[2025-01-27 10:30:16] Repository found: github.com/acme/terraform-aws-lambda-function-url',
          '[2025-01-27 10:30:17] Validating repository access...',
          '[2025-01-27 10:30:18] Repository access confirmed',
          '[2025-01-27 10:30:19] Check completed successfully'
        ]}
      />
      <CheckSummary
        status="success"
        summary="Terraform configuration validation passed."
        logs={[
          '[2025-01-27 10:30:20] Running terraform validate...',
          '[2025-01-27 10:30:21] Validating main.tf...',
          '[2025-01-27 10:30:22] Validating vars.tf...',
          '[2025-01-27 10:30:23] All configuration files are valid',
          '[2025-01-27 10:30:24] Validation completed successfully'
        ]}
      />
      <CheckSummary
        status="fail"
        summary="AWS permissions check failed - insufficient IAM permissions."
        logs={[
          '[2025-01-27 10:30:25] Checking AWS IAM permissions...',
          '[2025-01-27 10:30:26] Testing EC2 permissions...',
          '[2025-01-27 10:30:27] ERROR: Access denied for ec2:CreateSecurityGroup',
          '[2025-01-27 10:30:28] ERROR: Access denied for ec2:CreateVpc',
          '[2025-01-27 10:30:29] Check failed - please update IAM permissions'
        ]}
      />
      <CheckSummary
        status="warn"
        summary="You have read-only permissions but attempted to wrte."
        logs={[
          '[2025-01-27 10:30:25] Checking AWS IAM permissions...',
          '[2025-01-27 10:30:26] Testing EC2 permissions...',
          '[2025-01-27 10:30:27] ERROR: Access denied for ec2:CreateSecurityGroup',
          '[2025-01-27 10:30:28] ERROR: Access denied for ec2:CreateVpc',
          '[2025-01-27 10:30:29] Check failed - please update IAM permissions'
        ]}
      />
    </div>
  );
}

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
        <ChecksTabContent />
      </TabsContent>
      <TabsContent value="logs" className="mt-0 w-full">
        <LogsTabContent />
      </TabsContent>
    </div>
  </Tabs>
)
