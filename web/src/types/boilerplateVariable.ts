// API response for an individual boilerplate variable
export interface BoilerplateVariable {
  name: string;
  description: string;
  type: BoilerplateVariableType;
  default: string;
  required: boolean;
  options?: string[];
  validations?: ValidationRule[];
  // Runbooks extensions (x- prefixed in YAML, ignored by Boilerplate)
  schema?: Record<string, string>; // For structured maps: field name -> type mapping (YAML: x-schema)
  schemaInstanceLabel?: string; // Custom label for schema instances (YAML: x-schema-instance-label)
  // Which section this variable belongs to. See also: BoilerplateConfig.sections for ordered groupings.
  sectionName?: string; // (YAML: x-section)
}

export enum BoilerplateVariableType {
  String = "string",
  Int = "int", 
  Float = "float",
  Bool = "bool",
  List = "list",
  Map = "map",
  Enum = "enum"
}

// Validation rule for a boilerplate variable
export interface ValidationRule {
  type: BoilerplateValidationType
  message: string
  args?: unknown[]
}

// Define validation types enum to match the backend
export enum BoilerplateValidationType {
  Required = "required",
  URL = "url",
  Email = "email",
  Alpha = "alpha",
  Digit = "digit",
  Alphanumeric = "alphanumeric",
  CountryCode2 = "countrycode2",
  Semver = "semver",
  Length = "length",
  Custom = "custom"
}
