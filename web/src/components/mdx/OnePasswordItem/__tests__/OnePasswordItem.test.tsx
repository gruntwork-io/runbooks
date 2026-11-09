import { describe, it, expect, vi } from "vitest"
import { useEffect } from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ApiProvider } from "@/contexts/ApiContext"
import { useRunbookContext } from "@/contexts/useRunbook"
import { sensitiveOutput } from "@/lib/outputValues"
import { TestWrapper } from "@/test/test-utils"
import { OnePasswordItem } from "../OnePasswordItem"
import type { OnePasswordItemProps } from "../types"

const SAVED = { ok: true, itemId: "item1", title: "AWS prod", vaultId: "v1", vaultName: "Ops" }

function makeApi(reply: unknown = SAVED) {
  const invoke = vi.fn(async (_channel: string, _params?: unknown) => reply)
  const api = { invoke, on: vi.fn(() => () => {}) } as unknown as Parameters<
    typeof ApiProvider
  >[0]["api"]
  return { api, invoke }
}

/** Publishes an IAM user's keys, the secret one sensitive, as a Command would. */
function IamUser() {
  const { registerOutputs } = useRunbookContext()
  useEffect(
    () =>
      registerOutputs("iam", {
        ACCESS_KEY_ID: "AKIA1",
        SECRET_ACCESS_KEY: sensitiveOutput("s3cr3t"),
      }),
    [registerOutputs],
  )
  return null
}

const PROPS: OnePasswordItemProps = {
  id: "save-creds",
  vault: "Ops",
  itemTitle: "AWS prod",
  category: "API Credential",
  username: "{{ .outputs.iam.ACCESS_KEY_ID }}",
  password: "{{ .outputs.iam.SECRET_ACCESS_KEY }}",
}

function renderItem(
  props: Partial<OnePasswordItemProps> = {},
  options: { reply?: unknown; outputs?: boolean } = {},
) {
  const { api, invoke } = makeApi(options.reply)
  render(
    <ApiProvider api={api}>
      <TestWrapper>
        {options.outputs !== false && <IamUser />}
        <OnePasswordItem {...PROPS} {...props} />
      </TestWrapper>
    </ApiProvider>,
  )
  return { invoke }
}

describe("OnePasswordItem", () => {
  it("shows what it will save, with secrets masked", () => {
    renderItem()
    expect(screen.getAllByText("Save to 1Password")).toHaveLength(2) // title and button
    expect(screen.getByText("AKIA1")).toBeInTheDocument()
    expect(screen.getByText("••••••••")).toBeInTheDocument()
    expect(screen.queryByText("s3cr3t")).toBeNull()
  })

  it("waits for the outputs it saves", () => {
    renderItem({}, { outputs: false })
    expect(screen.getByRole("button", { name: "Save to 1Password" })).toBeDisabled()
  })

  it("sends the raw props and the real values for main to render", async () => {
    const { invoke } = renderItem()
    await userEvent.click(screen.getByRole("button", { name: "Save to 1Password" }))
    expect(invoke).toHaveBeenCalledWith("onepassword:create-item", {
      item: {
        vault: "Ops",
        title: "AWS prod",
        category: "API Credential",
        username: "{{ .outputs.iam.ACCESS_KEY_ID }}",
        password: "{{ .outputs.iam.SECRET_ACCESS_KEY }}",
        tags: [],
        fields: [],
      },
      templateVarValues: {
        inputs: {},
        outputs: { iam: { ACCESS_KEY_ID: "AKIA1", SECRET_ACCESS_KEY: "s3cr3t" } },
      },
    })
    expect(await screen.findByText(/Saved “AWS prod” to the Ops vault/)).toBeInTheDocument()
    expect(screen.getByText("OP_ITEM_ID")).toBeInTheDocument()
  })

  it("shows a failure inline and offers to try again", async () => {
    renderItem({}, { reply: { ok: false, error: "account is not signed in" } })
    await userEvent.click(screen.getByRole("button", { name: "Save to 1Password" }))
    expect(await screen.findByText("account is not signed in")).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled())
  })

  it("reports a missing vault as a configuration error", () => {
    renderItem({ vault: "" })
    expect(screen.getByText(/needs a vault/)).toBeInTheDocument()
  })
})
