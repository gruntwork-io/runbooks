import type { BoilerplateVariable } from './boilerplateVariable';

// API response for a collection of boilerplate variables
export interface BoilerplateConfig {
  variables: BoilerplateVariable[];
  rawYaml: string;  // The original YAML content
}