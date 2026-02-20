/** Props for the DirPicker MDX block component. */
export interface DirPickerProps {
  /** Unique block identifier (required). */
  id: string
  /** ID of a GitClone block whose clone path provides the root directory. If omitted, uses the active workspace root. */
  gitCloneId?: string
  /** Display title (supports inline markdown). */
  title?: string
  /** Description text (supports inline markdown). */
  description?: string
  /** Ordered labels for each cascading directory level (e.g., ['Environment', 'Region', 'Category']). Each dropdown is labelled with the corresponding entry. Also controls the maximum depth unless dirLabelsExtra is true. */
  dirLabels: string[]
  /** When true, allow navigating deeper than dirLabels.length. Extra levels are labelled "Level N". Defaults to false. */
  dirLabelsExtra?: boolean
  /** Label for the editable path input. Defaults to "Target Path". */
  pathLabel?: string
  /** Description text shown below the pathLabel. Supports inline markdown. */
  pathLabelDescription?: string
}
