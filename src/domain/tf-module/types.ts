/**
 * What a <TfModule> block knows about an OpenTofu module: its inputs from
 * variables.tf, shaped for a form by the module's runbook_block.yml.
 *
 * Shared by the main process, which builds it, and the renderer, which draws
 * the form from it.
 */
import type { Definitions, ShortcutUse, Use } from "../lookups/types.ts"

/** One choice for an input, with what it means. */
export interface TfModuleOption {
  /** The value the module receives. */
  readonly value: string
  readonly label: string
  readonly description?: string
}

/**
 * A named set of values for an input whose type is an object or map: picking
 * the preset sets the input to `settings`, and the form can show every
 * setting it holds.
 */
export interface TfModulePreset {
  readonly name: string
  readonly label: string
  readonly description?: string
  readonly settings: Readonly<Record<string, unknown>>
}

/**
 * A check the form can run before OpenTofu does, from a validation block in
 * variables.tf whose condition it recognizes.
 */
export type TfModuleCheck =
  | { readonly kind: "regex"; readonly pattern: string; readonly message: string }
  | {
      readonly kind: "length"
      readonly min: number
      readonly max: number
      readonly message: string
    }
  | { readonly kind: "notEmpty"; readonly message: string }

/** The form control an input needs, from its type in variables.tf. */
export type TfModuleInputKind = "string" | "number" | "bool" | "list" | "map" | "json"

export interface TfModuleVariable {
  readonly name: string
  readonly label: string
  readonly description: string
  /** The type as variables.tf writes it, such as `list(string)`. */
  readonly tfType: string
  readonly kind: TfModuleInputKind
  /** Whether variables.tf gives a default; without one, the input is required. */
  readonly hasDefault: boolean
  readonly default?: unknown
  readonly sensitive: boolean
  /** Shown first; the rest sit under Advanced options. */
  readonly primary: boolean
  readonly options?: readonly TfModuleOption[]
  /** Whether `options` lists every value the module accepts, so nothing else can be typed. */
  readonly optionsOnly?: boolean
  /** The lookup whose rows the input suggests. */
  readonly lookup?: Use
  /** A button that sets the input from a lookup's one row; its label is a template over the row's fields. */
  readonly shortcut?: ShortcutUse
  /** The lookup that fills the input when the form loads, if the input is empty. */
  readonly prefill?: Use
  readonly presets?: readonly TfModulePreset[]
  /**
   * A template over the form's values that ends the input's value, such as
   * `@{{ .domain }}`: the user types the rest, and the form shows this part fixed.
   */
  readonly suffix?: string
  /** Validations the form checks as the user types. */
  readonly checks?: readonly TfModuleCheck[]
  /**
   * The error messages of validations the form can't check, which only
   * OpenTofu applies, so the form shows them as rules to follow.
   */
  readonly constraints?: readonly string[]
}

/** A provider the module requires, from its required_providers. */
export interface TfModuleProvider {
  /** The local name, such as `google`. */
  readonly name: string
  /** The registry address, such as `hashicorp/google`. */
  readonly source?: string
  readonly version?: string
}

/** An output of the module, which the block publishes as its own output after an apply. */
export interface TfModuleOutput {
  readonly name: string
  readonly label: string
  readonly description: string
  readonly sensitive: boolean
  /** Show the value, an https: URL, as a link with this text. */
  readonly link?: string
}

export interface TfModuleSpec {
  readonly title: string
  readonly description?: string
  readonly providers: readonly TfModuleProvider[]
  /**
   * The logo the module's runbook_block.yml sets, as a data: or https: URL. Without
   * one, the form shows the mark of the module's first provider it knows.
   */
  readonly logo?: string
  /** In the order the module declares them. */
  readonly outputs: readonly TfModuleOutput[]
  /** The module's folder on GitHub, at the ref the block reads, when it lives there. */
  readonly page?: string
  /** In the order runbook_block.yml lists them, then the rest in the order variables.tf declares them. */
  readonly variables: readonly TfModuleVariable[]
  /** The lookups the inputs use, with the definitions they need. */
  readonly definitions: Definitions
  /** The checks to run before the module is planned, which a <TerragruntApply> block runs. */
  readonly preflight: readonly Use[]
  /** The lookup groups the inputs use, which the block's `auth` prop binds to auth blocks. */
  readonly authGroups: readonly string[]
  /** Problems in runbook_block.yml that don't stop the form, such as a key Runbooks doesn't know. */
  readonly warnings: readonly string[]
}
