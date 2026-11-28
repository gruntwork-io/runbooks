import { expect, it } from "bun:test"
import { fieldLabel } from "./label.ts"

// Today's cases (web/src/components/mdx/_shared/lib/formatVariableLabel.test.ts), and the
// names today's e2e finds fields by.
it.each([
  ["accountName", "Account Name"],
  ["emailAddress", "Email Address"],
  ["name", "Name"],
  ["url", "URL"],
  ["awsAccountName", "AWS Account Name"],
  ["databaseConnectionString", "Database Connection String"],
  ["apiEndpointUrl", "API Endpoint URL"],
  ["AllowedIPs", "Allowed IPs"],
  ["sdkVersion", "SDK Version"],
  ["oauthFlow", "Oauth Flow"],
  ["samlAssertion", "SAML Assertion"],
  ["XMLHttpRequest", "XML HTTP Request"],
  ["HTTPSConnection", "HTTPS Connection"],
  ["JSONWebToken", "JSON Web Token"],
  ["AWSAccountID", "AWS Account ID"],
  ["API", "API"],
  ["RANDOM", "RANDOM"],
  ["", ""],
  ["a", "A"],
  ["A", "A"],
  ["apiV2", "API V2"],
  ["http5Protocol", "HTTP5 Protocol"],
  ["ssl3Version", "SSL3 Version"],
  ["awsS3Bucket", "AWS S3 Bucket"],
  ["ec2InstanceType", "EC2 Instance Type"],
  ["rdsMysqlEngine", "RDS MySQL Engine"],
  ["rdsMysqlDatabaseUrl", "RDS MySQL Database URL"],
  ["project_name", "Project Name"],
  ["vpc_id", "VPC ID"],
  ["s3_bucket_name", "S3 Bucket Name"],
  ["ec2_instance_type", "EC2 Instance Type"],
  ["MysqlDatabase", "MySQL Database"],
  ["mongodbCollection", "MongoDB Collection"],
  ["GitHubOrgName", "GitHub Org Name"],
  ["AWSAccounts", "AWS Accounts"],
  ["AddAdditionalCommonVariables", "Add Additional Common Variables"],
  ["dbUrl", "DB URL"],
  ["DbPassword", "DB Password"],
  // A capital, a lower-case letter and a number, split by an underscore, make one acronym.
  ["E_c2", "EC2"],
])("labels %s as %s", (name, label) => {
  expect(fieldLabel(name)).toBe(label)
})
