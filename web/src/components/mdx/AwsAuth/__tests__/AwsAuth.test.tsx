import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ReactNode } from "react"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { RunbookProgressProbe, TestWrapper } from "@/test/test-utils"
import { ApiProvider } from "@/contexts/ApiContext"
import { makeTestApi, type Handlers, type TestApi } from "@/test/test-api"
import { useRunbookContext } from "@/contexts/useRunbook"

/**
 * The whole <AwsAuth> block: the real component, the real useAwsAuth hook, the
 * real sub-components and the real runbook context. The only thing faked is
 * the IPC surface behind useApi(), plus session readiness, which is ambient
 * state rather than behaviour under test. Detection, confirm and the SSO flow
 * are covered in depth by the hook tests; these check what the block renders
 * at each stage.
 */

vi.mock("@/contexts/useSession", () => ({
  useSession: () => ({ isReady: true }),
}))

import AwsAuth from "../AwsAuth"

let testApi: TestApi

/** Answers the channels in `handlers`; an invoke of any other channel rejects. */
function installApi(handlers: Handlers) {
  testApi = makeTestApi(handlers)
}

function renderBlock(children: ReactNode) {
  return render(
    <TestWrapper>
      <ApiProvider api={testApi.api}>{children}</ApiProvider>
      <RunbookProgressProbe />
    </TestWrapper>,
  )
}

const IDENTITY = {
  accountId: "111111111111",
  accountName: "staging",
  arn: "arn:aws:sts::111111111111:assumed-role/Deploy/run-1",
}

/** Stands in for a Command that writes AWS_* keys to $RUNBOOK_OUTPUT. */
function SourceBlock({ id }: { id: string }) {
  const { registerOutputs } = useRunbookContext()
  return (
    <button
      type="button"
      onClick={() =>
        registerOutputs(id, {
          AWS_ACCESS_KEY_ID: "ASIA_A",
          AWS_SECRET_ACCESS_KEY: "secret-a",
          AWS_SESSION_TOKEN: "token-a",
        })
      }
    >
      Run {id}
    </button>
  )
}

beforeEach(() => {
  // No IPC expected: every invoke rejects.
  installApi({})
})

describe("AwsAuth — rendering", () => {
  it("renders the default title, the three tabs and the static credentials form", () => {
    renderBlock(<AwsAuth id="test-aws" detectCredentials={false} />)

    expect(screen.getByTestId("test-aws")).toBeInTheDocument()
    expect(screen.getByText("AWS Authentication")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Static Credentials" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "AWS SSO" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Local Profile" })).toBeInTheDocument()
    expect(screen.getByPlaceholderText("AKIAIOSFODNN7EXAMPLE")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Authenticate" })).toBeDisabled()
    // Detection is off, so there is no hint or "Check again" and nothing was invoked.
    expect(screen.queryByTestId("detection-hint")).toBeNull()
    expect(testApi.invoke).not.toHaveBeenCalled()
  })

  it("opens the SSO form when its tab is picked", () => {
    renderBlock(
      <AwsAuth
        id="test-aws"
        detectCredentials={false}
        ssoStartUrl="https://acme.awsapps.com/start"
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "AWS SSO" }))

    expect(screen.getByText("https://acme.awsapps.com/start")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Sign in with SSO" })).toBeInTheDocument()
    expect(screen.queryByPlaceholderText("AKIAIOSFODNN7EXAMPLE")).toBeNull()
  })

  it("renders custom title", () => {
    renderBlock(<AwsAuth id="test-aws" detectCredentials={false} title="Connect to AWS" />)
    expect(screen.getByText("Connect to AWS")).toBeInTheDocument()
  })

  it("renders description", () => {
    renderBlock(
      <AwsAuth
        id="test-aws"
        detectCredentials={false}
        description="Authenticate with your AWS account"
      />,
    )
    expect(screen.getByText("Authenticate with your AWS account")).toBeInTheDocument()
  })

  it("shows error for missing id", () => {
    renderBlock(<AwsAuth id="" detectCredentials={false} />)
    expect(screen.getByText(/requires a non-empty 'id' prop/)).toBeInTheDocument()
  })

  it("has no error banners with valid props", () => {
    renderBlock(<AwsAuth id="test-aws" detectCredentials={false} />)
    const block = screen.getByTestId("test-aws")
    expect(block.querySelector('[data-testid^="error-"]')).toBeNull()
  })
})

describe("AwsAuth — detection", () => {
  it("waits for a block source that has not run, then prompts once it has", async () => {
    installApi({ "aws:validate": () => ({ valid: true, ...IDENTITY }) })
    renderBlock(
      <>
        <SourceBlock id="assume-role" />
        <AwsAuth id="test-aws" detectCredentials={[{ block: "assume-role" }]} />
      </>,
    )

    expect(await screen.findByText(/Waiting for/)).toHaveTextContent(
      "Waiting for assume-role to run...",
    )
    expect(screen.queryByRole("button", { name: "Static Credentials" })).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Run assume-role" }))

    expect(await screen.findByText("AWS Credentials Detected")).toBeInTheDocument()
    expect(screen.getByText("111111111111")).toBeInTheDocument()
    expect(screen.getByText("Source: Command Output")).toBeInTheDocument()
    expect(screen.queryByText(/Waiting for/)).toBeNull()
    expect(screen.queryByRole("button", { name: "Static Credentials" })).toBeNull()
  })

  it("prompts with env credentials and shows the account once they are confirmed", async () => {
    installApi({
      "aws:env-credentials": () => ({
        found: true,
        valid: true,
        ...IDENTITY,
        region: "us-east-1",
        hasSessionToken: false,
      }),
      "aws:env-credentials-confirm": () => ({
        valid: true,
        ...IDENTITY,
        accessKeyId: "AKIA_ENV",
        secretAccessKey: "env-secret",
        region: "us-east-1",
      }),
      "session:set-env-export": () => ({ ok: true }),
      "session:clear-env-export": () => ({ ok: true }),
      "aws:check-region": () => ({ enabled: true }),
    })
    renderBlock(<AwsAuth id="test-aws" />)

    expect(screen.getByText("Checking for existing credentials...")).toBeInTheDocument()
    expect(await screen.findByText("AWS Credentials Detected")).toBeInTheDocument()
    expect(screen.getByText("Source: Environment Variables")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Static Credentials" })).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Use These Credentials" }))

    expect(await screen.findByText("✓ Authenticated to AWS")).toBeInTheDocument()
    expect(screen.getByText("111111111111")).toBeInTheDocument()
    expect(screen.queryByText("AWS Credentials Detected")).toBeNull()

    // Re-authenticate goes back to the manual tabs, under the hint line and
    // its "Check again", which brings the detected credentials back.
    fireEvent.click(screen.getByRole("button", { name: "Re-authenticate" }))
    expect(screen.getByRole("button", { name: "Static Credentials" })).toBeInTheDocument()
    expect(screen.queryByText("✓ Authenticated to AWS")).toBeNull()
    expect(screen.getByTestId("detection-hint")).toHaveTextContent(
      "Sign in below with different credentials.",
    )
    fireEvent.click(screen.getByRole("button", { name: "Check again" }))
    expect(await screen.findByText("AWS Credentials Detected")).toBeInTheDocument()
  })

  it("turns red when the credentials expire within minutes, and signs in again on request", async () => {
    const expiresAt = new Date(Date.now() + 2 * 60_000).toISOString()
    installApi({
      "aws:env-credentials": () => ({ found: true, valid: true, ...IDENTITY }),
      "aws:env-credentials-confirm": () => ({
        valid: true,
        ...IDENTITY,
        accessKeyId: "ASIA_ENV",
        secretAccessKey: "env-secret",
        sessionToken: "env-token",
        region: "us-east-1",
        expiresAt,
      }),
      "session:set-env-export": () => ({ ok: true }),
      "session:clear-env-export": () => ({ ok: true }),
      "aws:check-region": () => ({ enabled: true }),
    })
    renderBlock(<AwsAuth id="test-aws" />)
    fireEvent.click(await screen.findByRole("button", { name: "Use These Credentials" }))

    expect(
      await screen.findByText("These credentials expire in less than 5 minutes"),
    ).toBeInTheDocument()
    expect(screen.getByText("✓ Authenticated to AWS")).toBeInTheDocument()
    expect(screen.getByTestId("test-aws")).toHaveClass("bg-destructive-muted")
    // Red, so not a step that's done
    expect(screen.getByTestId("runbook-progress")).toHaveTextContent("0/1")

    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }))
    expect(screen.getByRole("button", { name: "Static Credentials" })).toBeInTheDocument()
    expect(screen.queryByText(/These credentials/)).toBeNull()
  })

  it("counts as a step of the runbook, done while it shows it's signed in", async () => {
    installApi({
      "aws:env-credentials": () => ({ found: true, valid: true, ...IDENTITY }),
      "aws:env-credentials-confirm": () => ({
        valid: true,
        ...IDENTITY,
        accessKeyId: "AKIA_ENV",
        secretAccessKey: "env-secret",
        region: "us-east-1",
      }),
      "session:set-env-export": () => ({ ok: true }),
      "session:clear-env-export": () => ({ ok: true }),
      "aws:check-region": () => ({ enabled: true }),
    })
    renderBlock(<AwsAuth id="test-aws" />)
    const useCredentials = await screen.findByRole("button", { name: "Use These Credentials" })
    expect(screen.getByTestId("runbook-progress")).toHaveTextContent("0/1")

    fireEvent.click(useCredentials)
    expect(await screen.findByText("✓ Authenticated to AWS")).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId("runbook-progress")).toHaveTextContent("1/1"))

    fireEvent.click(screen.getByRole("button", { name: "Re-authenticate" }))
    expect(screen.getByTestId("runbook-progress")).toHaveTextContent("0/1")
  })

  it("stays green for credentials that expire hours from now", async () => {
    installApi({
      "aws:env-credentials": () => ({ found: true, valid: true, ...IDENTITY }),
      "aws:env-credentials-confirm": () => ({
        valid: true,
        ...IDENTITY,
        accessKeyId: "ASIA_ENV",
        secretAccessKey: "env-secret",
        region: "us-east-1",
        expiresAt: new Date(Date.now() + 8 * 60 * 60_000).toISOString(),
      }),
      "session:set-env-export": () => ({ ok: true }),
      "session:clear-env-export": () => ({ ok: true }),
      "aws:check-region": () => ({ enabled: true }),
    })
    renderBlock(<AwsAuth id="test-aws" />)
    fireEvent.click(await screen.findByRole("button", { name: "Use These Credentials" }))

    expect(await screen.findByText("✓ Authenticated to AWS")).toBeInTheDocument()
    expect(screen.getByTestId("test-aws")).toHaveClass("bg-success-muted")
    expect(screen.queryByText(/These credentials/)).toBeNull()
  })
})
