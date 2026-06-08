import { describe, it, expect, beforeEach } from 'vitest'
import { render, waitFor, fireEvent } from '@testing-library/react'
import { TestWrapper } from '@/test/test-utils'
import MDXContainer from './MDXContainer'

const TASK_MD = `# Tasks

- [x] First task
- [ ] Second task
`

// runbookPath's last segment ("tasklist") becomes the runbook name, which scopes
// the persisted checkbox keys: task-checkbox:tasklist:<slug>.
function renderRunbook(content = TASK_MD, runbookPath = 'testdata/demo/tasklist') {
  return render(
    <TestWrapper>
      <MDXContainer content={content} runbookPath={runbookPath} />
    </TestWrapper>,
  )
}

function taskCheckboxes(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLInputElement>('.task-list-item-checkbox'),
  )
}

async function findTaskCheckboxes(container: HTMLElement, count: number) {
  await waitFor(() => expect(taskCheckboxes(container)).toHaveLength(count))
  return taskCheckboxes(container)
}

describe('MDXContainer task-list checkboxes', () => {
  beforeEach(() => localStorage.clear())

  it('renders GFM task-list checkboxes as enabled and reflecting the markdown initial state', async () => {
    const { container } = renderRunbook()
    const [first, second] = await findTaskCheckboxes(container, 2)
    expect(first.disabled).toBe(false)
    expect(second.disabled).toBe(false)
    expect(first.checked).toBe(true) // - [x]
    expect(second.checked).toBe(false) // - [ ]
  })

  it('toggles on click and persists the choice across a remount', async () => {
    const { container, unmount } = renderRunbook()
    const [, second] = await findTaskCheckboxes(container, 2)

    fireEvent.click(second)
    expect(second.checked).toBe(true)
    expect(localStorage.getItem('task-checkbox:tasklist:second-task')).toBe('true')

    unmount()
    const { container: reopened } = renderRunbook()
    const [, secondAgain] = await findTaskCheckboxes(reopened, 2)
    expect(secondAgain.checked).toBe(true)
  })

  it('persists an un-check that overrides a markdown-checked default', async () => {
    const { container, unmount } = renderRunbook()
    const [first] = await findTaskCheckboxes(container, 2)

    fireEvent.click(first) // uncheck a box the markdown marked as done
    expect(first.checked).toBe(false)
    expect(localStorage.getItem('task-checkbox:tasklist:first-task')).toBe('false')

    unmount()
    const { container: reopened } = renderRunbook()
    const [firstAgain] = await findTaskCheckboxes(reopened, 2)
    expect(firstAgain.checked).toBe(false)
  })

  it('scopes persisted state per runbook', async () => {
    const { container, unmount } = renderRunbook(TASK_MD, 'testdata/demo/runbook-a')
    const [, second] = await findTaskCheckboxes(container, 2)
    fireEvent.click(second)
    expect(localStorage.getItem('task-checkbox:runbook-a:second-task')).toBe('true')
    unmount()

    // A different runbook with identical markdown starts from the markdown state.
    const { container: other } = renderRunbook(TASK_MD, 'testdata/demo/runbook-b')
    const [, otherSecond] = await findTaskCheckboxes(other, 2)
    expect(otherSecond.checked).toBe(false)
  })
})
