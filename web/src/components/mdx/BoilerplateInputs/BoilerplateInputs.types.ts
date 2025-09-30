// Define the enum to match the Go boilerplate package exactly

export interface BoilerplateInputsFormProps {
  id: string
  boilerplateConfig: BoilerplateConfig | null
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
