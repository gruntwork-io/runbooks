// Complete list of AWS regions
export const AWS_REGIONS = [
  // United States
  { code: "us-east-1", name: "US East (N. Virginia)", geography: "United States" },
  { code: "us-east-2", name: "US East (Ohio)", geography: "United States" },
  { code: "us-west-1", name: "US West (N. California)", geography: "United States" },
  { code: "us-west-2", name: "US West (Oregon)", geography: "United States" },
  // Africa
  { code: "af-south-1", name: "Africa (Cape Town)", geography: "South Africa" },
  // Asia Pacific
  { code: "ap-east-1", name: "Asia Pacific (Hong Kong)", geography: "Hong Kong" },
  { code: "ap-east-2", name: "Asia Pacific (Taipei)", geography: "Taiwan" },
  { code: "ap-south-1", name: "Asia Pacific (Mumbai)", geography: "India" },
  { code: "ap-south-2", name: "Asia Pacific (Hyderabad)", geography: "India" },
  { code: "ap-southeast-1", name: "Asia Pacific (Singapore)", geography: "Singapore" },
  { code: "ap-southeast-2", name: "Asia Pacific (Sydney)", geography: "Australia" },
  { code: "ap-southeast-3", name: "Asia Pacific (Jakarta)", geography: "Indonesia" },
  { code: "ap-southeast-4", name: "Asia Pacific (Melbourne)", geography: "Australia" },
  { code: "ap-southeast-5", name: "Asia Pacific (Malaysia)", geography: "Malaysia" },
  { code: "ap-southeast-6", name: "Asia Pacific (New Zealand)", geography: "New Zealand" },
  { code: "ap-southeast-7", name: "Asia Pacific (Thailand)", geography: "Thailand" },
  { code: "ap-northeast-1", name: "Asia Pacific (Tokyo)", geography: "Japan" },
  { code: "ap-northeast-2", name: "Asia Pacific (Seoul)", geography: "South Korea" },
  { code: "ap-northeast-3", name: "Asia Pacific (Osaka)", geography: "Japan" },
  // Canada
  { code: "ca-central-1", name: "Canada (Central)", geography: "Canada" },
  { code: "ca-west-1", name: "Canada West (Calgary)", geography: "Canada" },
  // Europe
  { code: "eu-central-1", name: "Europe (Frankfurt)", geography: "Germany" },
  { code: "eu-central-2", name: "Europe (Zurich)", geography: "Switzerland" },
  { code: "eu-west-1", name: "Europe (Ireland)", geography: "Ireland" },
  { code: "eu-west-2", name: "Europe (London)", geography: "United Kingdom" },
  { code: "eu-west-3", name: "Europe (Paris)", geography: "France" },
  { code: "eu-south-1", name: "Europe (Milan)", geography: "Italy" },
  { code: "eu-south-2", name: "Europe (Spain)", geography: "Spain" },
  { code: "eu-north-1", name: "Europe (Stockholm)", geography: "Sweden" },
  // Israel
  { code: "il-central-1", name: "Israel (Tel Aviv)", geography: "Israel" },
  // Mexico
  { code: "mx-central-1", name: "Mexico (Central)", geography: "Mexico" },
  // Middle East
  { code: "me-south-1", name: "Middle East (Bahrain)", geography: "Bahrain" },
  { code: "me-central-1", name: "Middle East (UAE)", geography: "United Arab Emirates" },
  // South America
  { code: "sa-east-1", name: "South America (São Paulo)", geography: "Brazil" },
] as const

export type AwsRegionCode = typeof AWS_REGIONS[number]['code']
