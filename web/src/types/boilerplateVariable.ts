// API response for an invdividual boilerplate variable
export interface BoilerplateVariable {
  name: string;
  description: string;
  type: BoilerplateVariableType;
  default: string;
  required: boolean;
  options?: string[];
  validations?: ValidationRule[];
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
