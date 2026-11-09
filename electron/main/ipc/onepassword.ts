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
  const { item, templateVarValues } = params
  // Every templated string, by a name that says where it came from in an error.
  const templates: Record<string, string> = {
    vault: item.vault,
    itemTitle: item.title,
    ...(item.username !== undefined ? { username: item.username } : {}),
    ...(item.password !== undefined ? { password: item.password } : {}),
    ...(item.url !== undefined ? { url: item.url } : {}),
    ...(item.notes !== undefined ? { notes: item.notes } : {}),
    ...(item.account !== undefined ? { account: item.account } : {}),
  }
  item.tags?.forEach((tag, i) => (templates[`tags[${i}]`] = tag))
  item.fields?.forEach((field, i) => {
    templates[`fields[${i}].label`] = field.label
    templates[`fields[${i}].value`] = field.value
  })

  try {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const rendered = yield* renderTemplateValues(templates, templateVarValues ?? {})
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

export function registerOnePasswordHandlers(): void {
  ipcMain.handle("onepassword:create-item", (_event, params: CreateOnePasswordItemParams) =>
    createOnePasswordItemFromTemplates(params),
  )
}
