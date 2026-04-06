/**
 * CLI symlink installation — VS Code-style "Install 'runbooks' command in PATH".
 *
 * Creates a symlink (macOS/Linux) or PATH entry (Windows) so the user can
 * invoke `runbooks` from any terminal.
 */
import { app } from "electron"
import * as fs from "fs"
import * as path from "path"
import { execFile as execFileCb } from "child_process"
import { promisify } from "util"

const execFile = promisify(execFileCb)

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const SYMLINK_DIR = "/usr/local/bin"
const SYMLINK_NAME = "runbooks"

function getSymlinkPath(): string {
  return path.join(SYMLINK_DIR, SYMLINK_NAME)
}

/**
 * Resolve the path to the bin/runbooks script inside the packaged app.
 *
 * In a packaged build, app.getAppPath() returns the `app.asar` path and
 * extraResources land next to it in the resources directory:
 *   macOS:  Contents/Resources/bin/runbooks
 *   Linux:  resources/bin/runbooks
 *   Windows: resources/bin/runbooks.cmd
 *
 * In development, app.getAppPath() returns the project root, so we look
 * for resources/bin/ directly within it.
 */
function getTargetBinPath(): string {
  const appPath = app.getAppPath()
  const ext = process.platform === "win32" ? "runbooks.cmd" : "runbooks"

  // Packaged: resources dir is the parent of app.asar
  const packagedPath = path.join(path.dirname(appPath), "bin", ext)
  if (fs.existsSync(packagedPath)) {
    return packagedPath
  }

  // Development: resources/bin/ is at the project root
  const devPath = path.join(appPath, "resources", "bin", ext)
  if (fs.existsSync(devPath)) {
    return devPath
  }

  // Fallback to packaged path (will produce a clear error)
  return packagedPath
}

/**
 * On Windows the shim is copied to a user-local directory and that directory
 * is added to the user's PATH.
 */
function getWindowsInstallDir(): string {
  const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local")
  return path.join(localAppData, "Runbooks", "bin")
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

export interface CliInstallStatus {
  installed: boolean
  symlinkPath?: string
  targetPath?: string
  platform: string
}

export async function checkCliInstall(): Promise<CliInstallStatus> {
  const platform = process.platform

  if (platform === "win32") {
    const installDir = getWindowsInstallDir()
    const shimPath = path.join(installDir, "runbooks.cmd")
    const installed = fs.existsSync(shimPath)
    return { installed, symlinkPath: shimPath, targetPath: getTargetBinPath(), platform }
  }

  // macOS / Linux
  const symlinkPath = getSymlinkPath()
  try {
    const stat = fs.lstatSync(symlinkPath)
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(symlinkPath)
      return { installed: true, symlinkPath, targetPath: target, platform }
    }
    // Exists but is not a symlink — might be a regular file
    return { installed: false, symlinkPath, platform }
  } catch {
    return { installed: false, symlinkPath, platform }
  }
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

export async function installCli(): Promise<{ ok: true; symlinkPath: string }> {
  const target = getTargetBinPath()

  if (!fs.existsSync(target)) {
    throw new Error(
      `CLI script not found at ${target}. Is the app installed correctly?`,
    )
  }

  if (process.platform === "win32") {
    return installWindows(target)
  }
  return installUnix(target)
}

function shellEscapePath(value: string): string {
  return value.replace(/'/g, "'\\''")
}

async function installUnix(target: string): Promise<{ ok: true; symlinkPath: string }> {
  const symlinkPath = getSymlinkPath()
  const cmd = `mkdir -p '${shellEscapePath(SYMLINK_DIR)}' && ln -sf '${shellEscapePath(target)}' '${shellEscapePath(symlinkPath)}'`

  if (process.platform === "darwin") {
    await execFile("osascript", [
      "-e",
      `do shell script "${cmd}" with administrator privileges`,
    ])
  } else {
    // Linux — use pkexec for graphical privilege escalation
    await execFile("pkexec", ["sh", "-c", cmd])
  }

  return { ok: true as const, symlinkPath }
}

async function installWindows(target: string): Promise<{ ok: true; symlinkPath: string }> {
  const installDir = getWindowsInstallDir()
  const shimPath = path.join(installDir, "runbooks.cmd")

  // Create directory and copy shim
  fs.mkdirSync(installDir, { recursive: true })
  fs.copyFileSync(target, shimPath)

  // Add to user PATH if not already present
  await addToWindowsPath(installDir)

  return { ok: true as const, symlinkPath: shimPath }
}

async function addToWindowsPath(dir: string): Promise<void> {
  // Read current user PATH from the registry
  const { stdout } = await execFile("reg", [
    "query",
    "HKCU\\Environment",
    "/v",
    "Path",
  ]).catch(() => ({ stdout: "" }))

  const match = stdout.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i)
  const currentPath = match ? match[1].trim() : ""

  // Check if already present (case-insensitive on Windows)
  const entries = currentPath.split(";").map((e) => e.toLowerCase())
  if (entries.includes(dir.toLowerCase())) {
    return
  }

  const newPath = currentPath ? `${currentPath};${dir}` : dir
  await execFile("reg", [
    "add",
    "HKCU\\Environment",
    "/v",
    "Path",
    "/t",
    "REG_EXPAND_SZ",
    "/d",
    newPath,
    "/f",
  ])

  // Broadcast WM_SETTINGCHANGE so running shells pick up the change
  try {
    await execFile("powershell", [
      "-NoProfile",
      "-Command",
      `Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition '[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'; $HWND_BROADCAST = [IntPtr]0xffff; $WM_SETTINGCHANGE = 0x1a; $result = [UIntPtr]::Zero; [Win32.NativeMethods]::SendMessageTimeout($HWND_BROADCAST, $WM_SETTINGCHANGE, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)`,
    ])
  } catch {
    // Non-fatal — user can restart their shell
  }
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

export async function uninstallCli(): Promise<{ ok: true }> {
  if (process.platform === "win32") {
    return uninstallWindows()
  }
  return uninstallUnix()
}

async function uninstallUnix(): Promise<{ ok: true }> {
  const symlinkPath = getSymlinkPath()
  const cmd = `rm -f '${symlinkPath}'`

  if (process.platform === "darwin") {
    await execFile("osascript", [
      "-e",
      `do shell script "${cmd}" with administrator privileges`,
    ])
  } else {
    await execFile("pkexec", ["sh", "-c", cmd])
  }

  return { ok: true as const }
}

async function uninstallWindows(): Promise<{ ok: true }> {
  const installDir = getWindowsInstallDir()
  const shimPath = path.join(installDir, "runbooks.cmd")

  // Remove shim file
  if (fs.existsSync(shimPath)) {
    fs.unlinkSync(shimPath)
  }

  // Remove from user PATH
  await removeFromWindowsPath(installDir)

  return { ok: true as const }
}

async function removeFromWindowsPath(dir: string): Promise<void> {
  const { stdout } = await execFile("reg", [
    "query",
    "HKCU\\Environment",
    "/v",
    "Path",
  ]).catch(() => ({ stdout: "" }))

  const match = stdout.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i)
  if (!match) return

  const currentPath = match[1].trim()
  const entries = currentPath.split(";").filter(
    (e) => e.toLowerCase() !== dir.toLowerCase(),
  )
  const newPath = entries.join(";")

  await execFile("reg", [
    "add",
    "HKCU\\Environment",
    "/v",
    "Path",
    "/t",
    "REG_EXPAND_SZ",
    "/d",
    newPath,
    "/f",
  ])
}
