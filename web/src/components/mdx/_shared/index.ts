// Export shared hooks
export { useScriptExecution } from './hooks/useScriptExecution'

// Export shared components
export { ViewLogs } from './components/ViewLogs'
export { ViewOutputs } from './components/ViewOutputs'
export { ViewSourceCode } from './components/ViewSourceCode'
export { Instruction } from './components/Instruction'
export type { InstructionProps, InstructionSource } from './components/Instruction'
export { InstructionModeBanner } from './components/InstructionModeBanner'
export { CompletionCheckbox } from './components/CompletionCheckbox'
export { useBlockCompletion } from './hooks/useBlockCompletion'
export { InlineMarkdown } from './components/InlineMarkdown'
export { UnmetDependenciesWarning } from './components/UnmetDependenciesWarning'
export { UnmetAuthDependencyWarning } from './components/UnmetAuthDependencyWarning'
export { BlockIdLabel } from './components/BlockIdLabel'

// Export shared utilities
export { extractInlineInputsId } from './lib/extractInlineInputsId'

