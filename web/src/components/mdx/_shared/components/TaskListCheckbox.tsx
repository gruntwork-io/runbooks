import type { ComponentPropsWithoutRef } from 'react'
import { useTaskCheckbox } from '../hooks/useTaskCheckbox'

/**
 * The interactive checkbox rendered in place of a markdown task-list item's
 * read-only checkbox. Owns its checked state via {@link useTaskCheckbox} so the
 * user can toggle it and have the choice persist across reloads.
 */
function InteractiveTaskCheckbox({
  taskKey,
  initialChecked,
}: {
  taskKey: string
  initialChecked: boolean
}) {
  const { checked, toggle } = useTaskCheckbox(taskKey, initialChecked)
  return (
    <input
      type="checkbox"
      className="task-list-item-checkbox cursor-pointer"
      checked={checked}
      onChange={toggle}
    />
  )
}

/**
 * Override for the `input` element produced when MDX renders markdown. GitHub
 * Flavored Markdown turns `- [ ]` / `- [x]` into a disabled `<input
 * type="checkbox">`; the `rehypeTaskListIds` plugin tags each of those with a
 * stable `data-task-key`. When we see that tag we swap in an interactive,
 * persisted checkbox so users can tick steps off as they work through a runbook.
 *
 * Any other `<input>` (e.g. raw HTML embedded in MDX) passes through unchanged.
 */
export function TaskListCheckbox(props: ComponentPropsWithoutRef<'input'>) {
  const taskKey = (props as Record<string, unknown>)['data-task-key']
  if (props.type === 'checkbox' && typeof taskKey === 'string') {
    return (
      <InteractiveTaskCheckbox
        taskKey={taskKey}
        initialChecked={Boolean(props.checked ?? props.defaultChecked)}
      />
    )
  }
  return <input {...props} />
}
