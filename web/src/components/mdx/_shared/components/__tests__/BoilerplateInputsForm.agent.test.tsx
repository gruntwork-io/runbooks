/**
 * The form's agent adapter: a linked value comes back with what it resolves
 * to, as the form's chip shows it, and an unresolvable one says why.
 */
import { describe, it, expect, vi } from "vitest"
import { useEffect } from "react"
import { BoilerplateInputsForm } from "../BoilerplateInputsForm"
import type { BoilerplateConfig } from "@/types/boilerplateConfig"
import { useRunbookContext } from "@/contexts/useRunbook"
import { renderWithAgent, askAgent } from "@/test/agent-harness"

const CONFIG = {
  variables: [
    {
      name: "TenantId",
      type: "string",
      description: "Tenant",
      default: "{{ .outputs.query_existing_config.tenant_id }}",
    },
    {
      name: "Count",
      type: "int",
      description: "How many",
      default: "{{ .outputs.query_existing_config.count }}",
    },
    {
      name: "Regions",
      type: "list",
      description: "Regions",
      default: ["{{ .outputs.query_existing_config.region }}", "westus"],
    },
    {
      name: "Missing",
      type: "string",
      description: "From nowhere",
      default: "{{ .outputs.nowhere.id }}",
    },
    { name: "Plain", type: "string", description: "Plain", default: "x" },
  ],
} as unknown as BoilerplateConfig

function SeedOutputs() {
  const { registerOutputs } = useRunbookContext()
  useEffect(() => {
    registerOutputs("query-existing-config", {
      tenant_id: "05547fca-1111",
      count: "3",
      region: "eastus",
    })
  }, [registerOutputs])
  return null
}

/** Resolves {{ .outputs.query_existing_config.X }} the way main's boilerplate does. */
function resolve(value: unknown, outputs: Record<string, Record<string, string>>): unknown {
  if (Array.isArray(value)) return value.map((item) => resolve(item, outputs))
  if (typeof value !== "string") return value
  return value.replace(
    /\{\{\s*\.outputs\.(\w+)\.(\w+)\s*\}\}/g,
    (match, block: string, name: string) => outputs[block]?.[name] ?? match,
  )
}

describe("form agent adapter — linked values", () => {
  it("returns each linked value resolved, for strings, numbers and lists", async () => {
    const api = renderWithAgent(
      <>
        <SeedOutputs />
        <BoilerplateInputsForm
          id="regenerate"
          blockType="Template"
          boilerplateConfig={CONFIG}
          onGenerate={vi.fn()}
        />
      </>,
      {
        "boilerplate:resolve-inputs": ((request: {
          inputs: Record<string, unknown>
          outputs: Record<string, Record<string, string>>
        }) => ({
          inputs: Object.fromEntries(
            Object.entries(request.inputs).map(([name, value]) => [
              name,
              resolve(value, request.outputs),
            ]),
          ),
        })) as never,
      },
    )
    await vi.waitFor(async () => {
      const detail = await askAgent(api, { op: "get_block", blockId: "regenerate" })
      const byName = Object.fromEntries(detail.inputs.map((f: { name: string }) => [f.name, f]))
      expect(byName.TenantId).toMatchObject({
        value: "{{ .outputs.query_existing_config.tenant_id }}",
        resolvedValue: "05547fca-1111",
      })
      expect(byName.Count).toMatchObject({ resolvedValue: "3" })
      expect(byName.Regions).toMatchObject({ resolvedValue: ["eastus", "westus"] })
      expect(byName.Missing).not.toHaveProperty("resolvedValue")
      expect(byName.Missing.unresolved.join()).toContain('"nowhere"')
      expect(byName.Plain).not.toHaveProperty("resolvedValue")
      expect(byName.Plain).not.toHaveProperty("unresolved")
    })
    const confirmed = await askAgent(api, { op: "confirm_inputs", blockId: "regenerate" })
    expect(
      confirmed.fields.find((f: { name: string }) => f.name === "TenantId").resolvedValue,
    ).toBe("05547fca-1111")
  })
})
