/**
 * What a <TofuModule> block knows about an OpenTofu module: its inputs from
 * variables.tf, shaped for a form by the module's runbooks.yml.
 *
 * Shared by the main process, which builds it, and the renderer, which draws
 * the form from it.
 */

/** One choice for an input, with what it means. */
export interface TofuModuleOption {
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
export interface TofuModulePreset {
  readonly name: string
  readonly label: string
  readonly description?: string
  readonly settings: Readonly<Record<string, unknown>>
}

/**
 * Where an input's suggestions come from: a lookup Runbooks provides, named by
 * `from`, such as `google.domains`. Each row it returns is a record of fields.
 */
export interface TofuModuleLookup {
  readonly from: string
  /** A template over a row's fields for what the form shows, such as `{{ .domainName }}`. */
  readonly label?: string
  /** The row field that becomes the input's value. Without it, the row's `value` field. */
  readonly value?: string
  /** Other inputs a pick fills in: input name to a template over the row's fields. */
  readonly sets?: Readonly<Record<string, string>>
}

/**
 * A button under an input that fills it from the first row of a lookup, such
 * as "Add Ana Lima as an owner" from `google.me`, the signed-in person.
 */
export type TofuModuleShortcut = Omit<TofuModuleLookup, "sets">

/**
 * A check the form can run before OpenTofu does, from a validation block in
 * variables.tf whose condition it recognizes.
 */
export type TofuModuleCheck =
  | { readonly kind: "regex"; readonly pattern: string; readonly message: string }
  | {
      readonly kind: "length"
      readonly min: number
      readonly max: number
      readonly message: string
    }
  | { readonly kind: "notEmpty"; readonly message: string }

/** The form control an input needs, from its type in variables.tf. */
export type TofuModuleInputKind = "string" | "number" | "bool" | "list" | "map" | "json"

export interface TofuModuleVariable {
  readonly name: string
  readonly label: string
  readonly description: string
  /** The type as variables.tf writes it, such as `list(string)`. */
  readonly tfType: string
  readonly kind: TofuModuleInputKind
  /** Whether variables.tf gives a default; without one, the input is required. */
  readonly hasDefault: boolean
  readonly default?: unknown
  readonly sensitive: boolean
  /** Shown first; the rest sit under Advanced options. */
  readonly primary: boolean
  readonly options?: readonly TofuModuleOption[]
  /** Whether `options` lists every value the module accepts, so nothing else can be typed. */
  readonly optionsOnly?: boolean
  readonly lookup?: TofuModuleLookup
  readonly shortcut?: TofuModuleShortcut
  readonly presets?: readonly TofuModulePreset[]
  /**
   * A template over the form's values that ends the input's value, such as
   * `@{{ .domain }}`: the user types the rest, and the form shows this part fixed.
   */
  readonly suffix?: string
  /** Validations the form checks as the user types. */
  readonly checks?: readonly TofuModuleCheck[]
  /**
   * The error messages of validations the form can't check, which only
   * OpenTofu applies, so the form shows them as rules to follow.
   */
  readonly constraints?: readonly string[]
}

/** A provider the module requires, from its required_providers. */
export interface TofuModuleProvider {
  /** The local name, such as `google`. */
  readonly name: string
  /** The registry address, such as `hashicorp/google`. */
  readonly source?: string
  readonly version?: string
}

/** An output of the module, which the block publishes as its own output after an apply. */
export interface TofuModuleOutput {
  readonly name: string
  readonly label: string
  readonly description: string
  readonly sensitive: boolean
  /** Show the value, an https: URL, as a link with this text. */
  readonly link?: string
}

export interface TofuModuleSpec {
  readonly title: string
  readonly description?: string
  readonly providers: readonly TofuModuleProvider[]
  /**
   * The logo the module's runbooks.yml sets, as a data: or https: URL. Without
   * one, the form shows the mark of the module's first provider it knows.
   */
  readonly logo?: string
  /**
   * Where code in a repository finds the module, from runbooks.yml, such as a
   * Git URL at a tag. Without one, the code points at the module's folder.
   */
  readonly source?: string
  /** In the order the module declares them. */
  readonly outputs: readonly TofuModuleOutput[]
  /** In the order runbooks.yml lists them, then the rest in the order variables.tf declares them. */
  readonly variables: readonly TofuModuleVariable[]
  /** Templates over the form's values that start the pull request the block opens. */
  readonly pullRequest?: TofuModulePullRequest
  /** Problems in runbooks.yml that don't stop the form, such as a key Runbooks doesn't know. */
  readonly warnings: readonly string[]
}

/** How the module's runbooks.yml starts a pull request, as templates over the form's values. */
export interface TofuModulePullRequest {
  readonly title?: string
  readonly description?: string
}
