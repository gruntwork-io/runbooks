/**
 * Conditional fields (x-show-when).
 *
 * The implementations live in src/domain/boilerplate/showWhen.ts so that the
 * `runbooks test` CLI hides, and skips validating, exactly the fields this
 * form does.
 */
import { formatVariableLabel } from "./formatVariableLabel"

export {
  emptyValue,
  hiddenVariables,
  showWhenProblems,
  withHiddenDefaults,
} from "../../../../../../src/domain/boilerplate/showWhen"

/**
 * A field's conditions in words, as instruction mode states them: "Only when
 * Subscription Layout is caf", or "Only when Subscription Layout is caf or
 * custom, and Region is us-east-1".
 */
export function describeShowWhen(showWhen: Readonly<Record<string, readonly string[]>>): string {
  const conditions = Object.entries(showWhen).map(
    ([name, accepted]) => `${formatVariableLabel(name)} is ${accepted.join(" or ")}`,
  )
  return `Only when ${conditions.join(", and ")}`
}
