import type { BoilerplateVariable } from './boilerplateVariable';

// Section represents a grouping of variables under a section header (Runbooks extension).
// Used for UI rendering (e.g., collapsible sections in the form).
// See also: BoilerplateVariable.sectionName for per-variable section lookup.
// YAML property: x-section
export interface Section {
  name: string;        // Section name ("" for unnamed/default section)
  variables: string[]; // Variable names in this section (in declaration order)
}

// API response for a collection of boilerplate variables
export interface BoilerplateConfig {
  variables: BoilerplateVariable[];
  rawYaml: string; // The original YAML content
  // Ordered list of section groupings for UI rendering.
  // Each Section contains a name and the list of variable names in that section.
  // Note: Individual variables also have a sectionName field for direct lookup.
  sections?: Section[];
}
