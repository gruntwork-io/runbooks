import { describe, it, expect } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { ApiProvider } from "@/contexts/ApiContext"
import { makeTestApi, type Handler } from "@/test/test-api"
import { ThemeProvider } from "@/contexts/ThemeContext"
import { WelcomeScreen } from "../WelcomeScreen"

/** Render the welcome screen with the CLI not installed and `install` answering `cli:install`. */
function renderWelcome(install: Handler<"cli:install">) {
  const testApi = makeTestApi({
    "cli:check-install": () => ({ installed: false, platform: "darwin" }),
    "cli:install": install,
    "native:set-theme": () => ({ ok: true }),
    "native:app-version": () => ({ version: "1.2.3" }),
  })
  render(
    <ApiProvider api={testApi.api}>
      <ThemeProvider>
        <WelcomeScreen />
      </ThemeProvider>
    </ApiProvider>,
  )
  return testApi
}

async function clickInstall() {
  const button = await screen.findByRole("button", { name: /install command line tool/i })
  await waitFor(() => expect(button).toBeEnabled())
  fireEvent.click(button)
  return button
}

describe("WelcomeScreen", () => {
  it("shows the app version", async () => {
    renderWelcome(() => Promise.resolve({ ok: true, symlinkPath: "/usr/local/bin/runbooks" }))
    expect(await screen.findByText("Runbooks v1.2.3")).toBeInTheDocument()
  })
})

describe("WelcomeScreen CLI install", () => {
  it("shows why the install failed, without Electron's IPC wrapper", async () => {
    renderWelcome(() =>
      Promise.reject(
        new Error(
          "Error invoking remote method 'cli:install': Error: A different 'runbooks' command (possibly the older Runbooks CLI) already exists at /usr/local/bin/runbooks, and Runbooks will not overwrite it. Remove or rename it, then try again.",
        ),
      ),
    )
    const button = await clickInstall()

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent(
      /^A different 'runbooks' command \(possibly the older Runbooks CLI\) already exists at \/usr\/local\/bin\/runbooks/,
    )
    // Still offered, so the user can retry after moving the other file aside.
    await waitFor(() => expect(button).toBeEnabled())
  })

  it("stays quiet when the user dismisses the administrator prompt", async () => {
    const testApi = renderWelcome(() =>
      Promise.reject(
        new Error(
          "Error invoking remote method 'cli:install': Error: Command failed: osascript -e do shell script \"...\" with administrator privileges\n0:120: execution error: User canceled. (-128)",
        ),
      ),
    )
    const button = await clickInstall()

    await waitFor(() => expect(testApi.invoke).toHaveBeenCalledWith("cli:install"))
    await waitFor(() => expect(button).toBeEnabled())
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("clears the error and shows the command once a retry succeeds", async () => {
    let attempts = 0
    renderWelcome(() => {
      attempts += 1
      return attempts === 1
        ? Promise.reject(
            new Error("Error invoking remote method 'cli:install': Error: spawn pkexec ENOENT"),
          )
        : Promise.resolve({ ok: true, symlinkPath: "/usr/local/bin/runbooks" })
    })

    await clickInstall()
    expect(await screen.findByRole("alert")).toHaveTextContent("spawn pkexec ENOENT")

    await clickInstall()
    expect(await screen.findByText("Installed")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})
