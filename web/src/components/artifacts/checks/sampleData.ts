import type { CheckSummaryProps } from './CheckSummary';

// Sample data structure for checks demonstration
export const sampleCheckData: CheckSummaryProps[] = [
  {
    status: "success",
    summary: "The repo github.com/acme/terraform-aws-lambda-function-url exists.",
    logs: [
      '[2025-01-27 10:30:15] Checking repository existence...',
      '[2025-01-27 10:30:16] Repository found: github.com/acme/terraform-aws-lambda-function-url',
      '[2025-01-27 10:30:17] Validating repository access...',
      '[2025-01-27 10:30:18] Repository access confirmed',
      '[2025-01-27 10:30:19] Check completed successfully'
    ]
  },
  {
    status: "success",
    summary: "Terraform configuration validation passed.",
    logs: [
      '[2025-01-27 10:30:20] Running terraform validate...',
      '[2025-01-27 10:30:21] Validating main.tf...',
      '[2025-01-27 10:30:22] Validating vars.tf...',
      '[2025-01-27 10:30:23] All configuration files are valid',
      '[2025-01-27 10:30:24] Validation completed successfully'
    ]
  },
  {
    status: "fail",
    summary: "AWS permissions check failed - insufficient IAM permissions.",
    logs: [
      '[2025-01-27 10:30:25] Checking AWS IAM permissions...',
      '[2025-01-27 10:30:26] Testing EC2 permissions...',
      '[2025-01-27 10:30:27] ERROR: Access denied for ec2:CreateSecurityGroup',
      '[2025-01-27 10:30:28] ERROR: Access denied for ec2:CreateVpc',
      '[2025-01-27 10:30:29] Check failed - please update IAM permissions'
    ]
  },
  {
    status: "warn",
    summary: "You have read-only permissions but attempted to write.",
    logs: [
      '[2025-01-27 10:30:30] Checking AWS IAM permissions...',
      '[2025-01-27 10:30:31] Testing EC2 permissions...',
      '[2025-01-27 10:30:32] WARNING: Limited permissions detected',
      '[2025-01-27 10:30:33] WARNING: Cannot perform write operations',
      '[2025-01-27 10:30:34] Consider upgrading permissions for full functionality'
    ]
  },
  {
    status: "success",
    summary: "Docker image build completed successfully.",
    logs: [
      '[2025-01-27 10:30:35] Starting Docker build...',
      '[2025-01-27 10:30:36] Building image: myapp:latest',
      '[2025-01-27 10:30:37] Step 1/5: FROM node:18-alpine',
      '[2025-01-27 10:30:38] Step 2/5: COPY package*.json ./',
      '[2025-01-27 10:30:39] Step 3/5: RUN npm install',
      '[2025-01-27 10:30:40] Step 4/5: COPY . .',
      '[2025-01-27 10:30:41] Step 5/5: CMD ["npm", "start"]',
      '[2025-01-27 10:30:42] Build completed successfully'
    ]
  },
  {
    status: "fail",
    summary: "Database connection test failed - connection timeout.",
    logs: [
      '[2025-01-27 10:30:43] Testing database connection...',
      '[2025-01-27 10:30:44] Attempting to connect to postgresql://localhost:5432/mydb',
      '[2025-01-27 10:30:45] Connection timeout after 30 seconds',
      '[2025-01-27 10:30:46] ERROR: Database server appears to be down',
      '[2025-01-27 10:30:47] Please check database status and network connectivity'
    ]
  },
  {
    status: "warn",
    summary: "SSL certificate expires in 30 days.",
    logs: [
      '[2025-01-27 10:30:48] Checking SSL certificate status...',
      '[2025-01-27 10:30:49] Certificate found: *.example.com',
      '[2025-01-27 10:30:50] Expiration date: 2025-02-26',
      '[2025-01-27 10:30:51] WARNING: Certificate expires in 30 days',
      '[2025-01-27 10:30:52] Consider renewing certificate soon'
    ]
  }
];
