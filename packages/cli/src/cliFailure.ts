/** What a person reads when a command could not do what it was asked. */
import type { CliFailure } from "./contract.ts"

export function describeFailure(failure: CliFailure): string {
  switch (failure._tag) {
    case "NoRunbooks":
      return `No runbook found in ${failure.patterns.join(", ")}.`
    case "PathNotFound":
      return `There is no file or folder at ${failure.path}.`
    case "Unreadable":
      return `${failure.path} could not be read: ${failure.message}`
    case "TooManyFiles":
      return `${failure.path} holds more than ${failure.limit} files and folders. Name a smaller folder.`
    case "TestCaseNotFound":
      return `No test case is named ${failure.name} in the ${failure.runbooks} runbooks tested.`
    case "BadFlag":
      return `${failure.flag}: ${failure.message}`
    case "Cancelled":
      return "Stopped by Ctrl-C or SIGTERM: the running block was cancelled, and nothing after it ran."
    default: {
      const unhandled: never = failure
      throw new Error(`Unhandled CLI failure: ${JSON.stringify(unhandled)}`)
    }
  }
}
