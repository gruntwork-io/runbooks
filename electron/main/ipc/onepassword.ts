/**
 * IPC handler for the <OnePasswordItem> block.
 *
 * The renderer sends the block's props as templates and the values to render
 * them with; MAIN renders them, as it renders a script, so a sensitive output
 * reaches 1Password with its real value and the renderer never has to put it
 * into a prop. The reply carries the item's IDs, never what was saved.
 */
import { ipcMain } from "electron"
import { Effect } from "effect"
import { runtime } from "./runtime.ts"
import { renderTemplateValues } from "../../../src/domain/exec/render.ts"
import {
  decodeOutputs,
  maskOutputs,
  revealOutputs,
  type EncodedOutputValues,
  type OutputValues,
} from "../../../src/domain/exec/outputValues.ts"
import {
  createOnePasswordItem,
  type OnePasswordCategory,
  type OnePasswordFieldType,
} from "../../../src/domain/onepassword/item.ts"
import { errorMessage } from "../../../src/errors/message.ts"
import type {
  CreateOnePasswordItemParams,
  CreateOnePasswordItemResult,
} from "../../shared/channels.ts"

/** The `onepassword:create-item` handler, outside ipcMain so tests can call it. */
export async function createOnePasswordItemFromTemplates(
  params: CreateOnePasswordItemParams,
): Promise<CreateOnePasswordItemResult> {
  const { item } = params
  const inputs = params.templateInputs ?? {}
  const outputs = decodeTemplateOutputs(params.templateOutputs ?? {})
  // Every templated string, by a name that says where it came from in an error.
  // Only what goes into the item's fields may read a sensitive output: the
  // rest is passed to `op` as arguments or comes back in the block's outputs.
  const secretTemplates: Record<string, string> = {
    ...(item.username !== undefined ? { username: item.username } : {}),
    ...(item.password !== undefined ? { password: item.password } : {}),
    ...(item.notes !== undefined ? { notes: item.notes } : {}),
  }
  const shownTemplates: Record<string, string> = {
    vault: item.vault,
    itemTitle: item.title,
    ...(item.url !== undefined ? { url: item.url } : {}),
    ...(item.account !== undefined ? { account: item.account } : {}),
  }
  item.tags?.forEach((tag, i) => (shownTemplates[`tags[${i}]`] = tag))
  item.fields?.forEach((field, i) => {
    shownTemplates[`fields[${i}].label`] = field.label
    secretTemplates[`fields[${i}].value`] = field.value
  })
  const templates = { ...shownTemplates, ...secretTemplates }

  try {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const shown = yield* renderTemplateValues(shownTemplates, {
          inputs,
          outputs: mapValues(outputs, maskOutputs),
        })
        const readsSensitive = Object.keys(shownTemplates).filter((name) =>
          shown[name]!.includes(REDACTED),
        )
        if (readsSensitive.length > 0) {
          return yield* Effect.fail(
            new Error(
              `${readsSensitive.join(", ")} ${readsSensitive.length === 1 ? "reads" : "read"} a sensitive output, so nothing was saved. Only username, password, notes and field values can.`,
            ),
          )
        }
        const rendered = {
          ...shown,
          ...(yield* renderTemplateValues(secretTemplates, {
            inputs,
            outputs: mapValues(outputs, revealOutputs),
          })),
        }
        // A prop that renders empty would save an item missing what the runbook meant it to hold.
        const empty = Object.keys(templates).filter(
          (name) => templates[name]!.trim() !== "" && (rendered[name] ?? "").trim() === "",
        )
        if (empty.length > 0) {
          return yield* Effect.fail(
            new Error(
              `${empty.join(", ")} came out empty, so nothing was saved. Check that the outputs ${empty.length === 1 ? "it reads have" : "they read have"} values.`,
            ),
          )
        }
        return yield* createOnePasswordItem({
          vault: rendered.vault!,
          title: rendered.itemTitle!,
          category: (item.category ?? "Login") as OnePasswordCategory,
          username: rendered.username,
          password: rendered.password,
          url: rendered.url,
          notes: rendered.notes,
          account: rendered.account,
          tags: item.tags?.map((_, i) => rendered[`tags[${i}]`]!),
          fields: item.fields?.map((field, i) => ({
            label: rendered[`fields[${i}].label`]!,
            value: rendered[`fields[${i}].value`]!,
            type: field.type as OnePasswordFieldType | undefined,
          })),
        })
      }),
    )
    return { ok: true, ...result }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  }
}

/** What `maskOutput` shows in place of a sensitive value. */
const REDACTED = "<redacted>"

function decodeTemplateOutputs(
  encoded: Record<string, EncodedOutputValues>,
): Record<string, OutputValues> {
  return mapValues(encoded, decodeOutputs)
}

function mapValues<A, B>(record: Record<string, A>, f: (value: A) => B): Record<string, B> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, f(value)]))
}

export function registerOnePasswordHandlers(): void {
  ipcMain.handle("onepassword:create-item", (_event, params: CreateOnePasswordItemParams) =>
    createOnePasswordItemFromTemplates(params),
  )
}
