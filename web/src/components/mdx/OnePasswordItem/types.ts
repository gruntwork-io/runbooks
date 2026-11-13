import type {
  OnePasswordCategory,
  OnePasswordField,
} from "../../../../../src/domain/onepassword/item"

export type { OnePasswordCategory, OnePasswordField }

export interface OnePasswordItemProps {
  id: string
  /** Display title (supports template expressions). */
  title?: string
  /** Display description (supports template expressions). */
  description?: string
  /** The vault to save the item in, by name or ID. */
  vault: string
  /** The item's title in 1Password. */
  itemTitle: string
  /** Defaults to Login. */
  category?: OnePasswordCategory
  username?: string
  password?: string
  /** The item's website. */
  url?: string
  notes?: string
  tags?: string[]
  /** More fields. Each is concealed unless its type says otherwise. */
  fields?: OnePasswordField[]
  /** The 1Password account, when the CLI is signed in to more than one. */
  account?: string
  inputsId?: string | string[]
  autoCollapse?: boolean
}

export type OnePasswordItemStatus = "ready" | "saving" | "success" | "fail"
