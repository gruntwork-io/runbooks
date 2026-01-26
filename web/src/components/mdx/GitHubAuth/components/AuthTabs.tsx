import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { GitHubAuthMethod } from "../types"

interface AuthTabsProps {
  authMethod: GitHubAuthMethod
  setAuthMethod: (method: GitHubAuthMethod) => void
}

export function AuthTabs({ authMethod, setAuthMethod }: AuthTabsProps) {
  return (
    <Tabs value={authMethod} onValueChange={(v) => setAuthMethod(v as GitHubAuthMethod)} className="mb-4">
      <TabsList className="w-full">
        <TabsTrigger value="token" className="flex-1">
          Personal Access Token
        </TabsTrigger>
        <TabsTrigger value="device" className="flex-1">
          Device Flow
        </TabsTrigger>
      </TabsList>
    </Tabs>
  )
}
