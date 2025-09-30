// Define the enum to match the Go boilerplate package exactly
export enum BoilerplateVariableType {
  String = "string",
  Int = "int", 
  Float = "float",
  Bool = "bool",
  List = "list",
  Map = "map",
  Enum = "enum"
}

// Define validation types enum to match the backend
export enum BoilerplateValidationType {
  Required = "required",
  URL = "url",
  Email = "email",
  Alpha = "alpha",
  Digit = "digit",
  Alphanumeric = "alphanumeric",
  CountryCode2 = "countrycode2",
  Semver = "semver",
  Length = "length",
  Custom = "custom"
}

export interface ValidationRule {
  type: BoilerplateValidationType
  message: string
  args?: unknown[]
}

export interface BoilerplateVariable {
  name: string
  description: string
  type: BoilerplateVariableType
  default: unknown
  required: boolean
  options?: string[]
  validations?: ValidationRule[]
}

export interface BoilerplateConfig {
  variables: BoilerplateVariable[]
}

export interface BoilerplateInputsFormProps {
  id: string
  boilerplateConfig: BoilerplateConfig
  initialData?: Record<string, unknown>
  onFormChange?: (formData: Record<string, unknown>) => void
  onAutoRender?: (formData: Record<string, unknown>) => void
  onSubmit?: (formData: Record<string, unknown>) => void
  submitButtonText?: string
  showSubmitButton?: boolean
  isGenerating?: boolean
  isAutoRendering?: boolean
  showSuccessIndicator?: boolean
  enableAutoRender?: boolean
  hasGeneratedSuccessfully?: boolean
}
