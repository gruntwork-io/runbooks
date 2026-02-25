import type { BoilerplateVariable } from './boilerplateVariable';

// Section represents a grouping of variables under a section header (Runbooks extension).
// Used for UI rendering (e.g., collapsible sections in the form).
// See also: BoilerplateVariable.sectionName for per-variable section lookup.
// YAML property: x-section
export interface Section {
  name: string;        // Section name ("" for unnamed/default section)
  variables: string[]; // Variable names in this section (in declaration order)
}

// OutputDependency represents a reference to another block's output found in a template file.
// These are {{ ._blocks.blockId.outputs.outputName }} patterns that the Template component
// uses to show warnings when dependent Check/Command blocks haven't been executed yet.
export interface OutputDependency {
  blockId: string;    // The block ID that produces the output (e.g., "create-account")
  outputName: string; // The output name (e.g., "account_id")
  fullPath: string;   // The full template reference (e.g., "_blocks.create-account.outputs.account_id")
}

// TfModuleMetadata contains additional metadata extracted from an OpenTofu module directory.
export interface TfModuleMetadata {
  folder_name: string;     // Name of the containing directory (e.g., "lambda-edge")
  readme_title: string;    // First h1 heading from README.md, or empty string
  output_names: string[];  // Names of output blocks (sorted)
  resource_names: string[]; // Names of resource blocks as "type.name" (sorted, excludes data sources)
}

// API response for a collection of boilerplate variables
export interface BoilerplateConfig {
  variables: BoilerplateVariable[];
  // Ordered list of section groupings for UI rendering.
  // Each Section contains a name and the list of variable names in that section.
  // Note: Individual variables also have a sectionName field for direct lookup.
  sections?: Section[];
  // Output dependencies found by scanning template files for {{ ._blocks.*.outputs.* }} patterns.
  // The Template component uses this to show warnings when dependent blocks haven't been executed.
  outputDependencies?: OutputDependency[];
  // Module metadata (only present for TfModule parse responses)
  metadata?: TfModuleMetadata;
}
