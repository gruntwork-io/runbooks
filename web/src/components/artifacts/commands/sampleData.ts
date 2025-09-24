import type { CommandSummaryProps } from './CommandSummary';

// Sample data structure for commands demonstration
export const sampleCommandData: CommandSummaryProps[] = [
  {
    status: "succeed",
    command: "terraform init",
    logs: [
      '[2025-01-27 10:30:15] Initializing Terraform...',
      '[2025-01-27 10:30:16] Downloading provider plugins...',
      '[2025-01-27 10:30:17] Provider registry.terraform.io/hashicorp/aws v5.0.0',
      '[2025-01-27 10:30:18] Initialization completed successfully',
      '[2025-01-27 10:30:19] Terraform has been successfully initialized!'
    ]
  },
  {
    status: "succeed",
    command: "terraform plan -out=tfplan",
    logs: [
      '[2025-01-27 10:30:20] Running terraform plan...',
      '[2025-01-27 10:30:21] Refreshing Terraform state...',
      '[2025-01-27 10:30:22] Plan: 2 to add, 0 to change, 0 to destroy',
      '[2025-01-27 10:30:23] aws_vpc.main will be created',
      '[2025-01-27 10:30:24] aws_security_group.web will be created',
      '[2025-01-27 10:30:25] Plan completed successfully'
    ]
  },
  {
    status: "fail",
    command: "terraform apply tfplan",
    logs: [
      '[2025-01-27 10:30:26] Running terraform apply...',
      '[2025-01-27 10:30:27] Creating aws_vpc.main...',
      '[2025-01-27 10:30:28] ERROR: Access denied for ec2:CreateVpc',
      '[2025-01-27 10:30:29] ERROR: Insufficient permissions to create VPC',
      '[2025-01-27 10:30:30] Please check your AWS credentials and permissions',
      '[2025-01-27 10:30:31] Command failed'
    ]
  },
  {
    status: "fail",
    command: "docker build -t myapp:latest .",
    logs: [
      '[2025-01-27 10:30:32] Building Docker image...',
      '[2025-01-27 10:30:33] Step 1/5: FROM node:18-alpine',
      '[2025-01-27 10:30:34] Step 2/5: COPY package*.json ./',
      '[2025-01-27 10:30:35] ERROR: Dockerfile syntax error at line 3',
      '[2025-01-27 10:30:36] ERROR: Invalid instruction "RUNN"',
      '[2025-01-27 10:30:37] Build failed'
    ]
  },
  {
    status: "succeed",
    command: "npm install",
    logs: [
      '[2025-01-27 10:30:38] Installing npm dependencies...',
      '[2025-01-27 10:30:39] Found 15 packages to install',
      '[2025-01-27 10:30:40] Installing react@18.2.0',
      '[2025-01-27 10:30:41] Installing typescript@5.0.0',
      '[2025-01-27 10:30:42] All packages installed successfully'
    ]
  },
  {
    status: "fail",
    command: "aws s3 ls s3://my-bucket",
    logs: [
      '[2025-01-27 10:30:43] Running aws s3 ls...',
      '[2025-01-27 10:30:44] ERROR: aws: command not found',
      '[2025-01-27 10:30:45] Please install AWS CLI first',
      '[2025-01-27 10:30:46] Command failed'
    ]
  },
  {
    status: "succeed",
    command: "git push origin main",
    logs: [
      '[2025-01-27 10:30:47] Pushing to remote repository...',
      '[2025-01-27 10:30:48] Enumerating objects: 5, done.',
      '[2025-01-27 10:30:49] Counting objects: 100% (5/5), done.',
      '[2025-01-27 10:30:50] Compressing objects: 100% (3/3), done.',
      '[2025-01-27 10:30:51] Writing objects: 100% (3/3), 245 bytes',
      '[2025-01-27 10:30:52] Push completed successfully'
    ]
  },
  {
    status: "fail",
    command: "kubectl apply -f deployment.yaml",
    logs: [
      '[2025-01-27 10:30:53] Applying Kubernetes manifests...',
      '[2025-01-27 10:30:54] ERROR: validation failed for deployment.yaml',
      '[2025-01-27 10:30:55] ERROR: Invalid resource specification',
      '[2025-01-27 10:30:56] ERROR: Missing required field "spec.template.spec.containers"',
      '[2025-01-27 10:30:57] Command failed'
    ]
  },
  {
    status: "succeed",
    command: "npm run build",
    logs: [
      '[2025-01-27 10:30:58] Building application...',
      '[2025-01-27 10:30:59] Compiling TypeScript...',
      '[2025-01-27 10:31:00] Bundling assets...',
      '[2025-01-27 10:31:01] Build completed successfully',
      '[2025-01-27 10:31:02] Output written to dist/'
    ]
  },
  {
    status: "fail",
    command: "docker run -p 3000:3000 myapp:latest",
    logs: [
      '[2025-01-27 10:31:03] Starting container...',
      '[2025-01-27 10:31:04] ERROR: Port 3000 is already in use',
      '[2025-01-27 10:31:05] ERROR: Cannot bind to port 3000',
      '[2025-01-27 10:31:06] Please stop the existing service or use a different port',
      '[2025-01-27 10:31:07] Command failed'
    ]
  }
];
