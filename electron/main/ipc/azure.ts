import { ipcMain } from "electron"
import {
  handleChangeTenant,
  handleConfirmDetected,
  handleDetect,
  handleCancel,
  handleLoginPoll,
  handleLoginStart,
  handleSelectContext,
  handleServicePrincipal,
  handleTenantLoginStart,
  handleValidateSession,
} from "./azure-signin.ts"
import type { IpcChannelMap } from "../../shared/channels.ts"

type Params<C extends keyof IpcChannelMap> = IpcChannelMap[C]["params"]

export function registerAzureHandlers(): void {
  ipcMain.handle("azure:detect", (_event, params: Params<"azure:detect">) => handleDetect(params))
  ipcMain.handle("azure:confirm-detected", (_event, params: Params<"azure:confirm-detected">) =>
    handleConfirmDetected(params),
  )
  ipcMain.handle("azure:login-start", (_event, params: Params<"azure:login-start">) =>
    handleLoginStart(params),
  )
  ipcMain.handle("azure:tenant-login-start", (_event, params: Params<"azure:tenant-login-start">) =>
    handleTenantLoginStart(params),
  )
  ipcMain.handle("azure:login-poll", (_event, params: Params<"azure:login-poll">) =>
    handleLoginPoll(params),
  )
  ipcMain.handle("azure:cancel", (_event, params: Params<"azure:cancel">) => handleCancel(params))
  ipcMain.handle("azure:service-principal", (_event, params: Params<"azure:service-principal">) =>
    handleServicePrincipal(params),
  )
  ipcMain.handle("azure:select-context", (_event, params: Params<"azure:select-context">) =>
    handleSelectContext(params),
  )
  ipcMain.handle("azure:change-tenant", (_event, params: Params<"azure:change-tenant">) =>
    handleChangeTenant(params),
  )
  ipcMain.handle("azure:validate-session", (_event, params: Params<"azure:validate-session">) =>
    handleValidateSession(params),
  )
}
