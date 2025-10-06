# ECS Service with ALB

This Terraform module deploys a Docker application on AWS ECS (Elastic Container Service) with an Application Load Balancer (ALB) in front of it.

## What gets deployed?

1. **ECS Cluster** - A cluster of EC2 instances to run your Docker containers
2. **Application Load Balancer (ALB)** - Routes HTTP traffic to your ECS tasks
3. **ECS Service** - Manages the deployment and scaling of your Docker containers
4. **S3 Bucket** - For testing IAM permissions (demonstration purposes)
5. **IAM Roles and Policies** - Proper permissions for ECS tasks to access AWS services
6. **Security Groups** - Network security configuration
7. **CloudWatch Log Groups** - For container logs

## Prerequisites

Before deploying this infrastructure, you need:

1. **AWS Account** with appropriate permissions
2. **ECS-optimized AMI ID** for your region
3. **EC2 Key Pair** for SSH access to the ECS cluster instances
4. **Terraform** (>= 1.0.0) or **OpenTofu** installed
5. **AWS CLI** configured with your credentials

## How to use this module

1. Fill in the required variables in the boilerplate form
2. Run `terraform init` to initialize the Terraform modules
3. Run `terraform plan` to see what will be created
4. Run `terraform apply` to deploy the infrastructure
5. Access your application using the ALB DNS name (output after apply)

## Architecture

```
Internet
    |
    v
Application Load Balancer (ALB)
    |
    v
ECS Service (Tasks)
    |
    v
ECS Cluster (EC2 Instances)
```

The ALB receives HTTP traffic and routes it to healthy ECS tasks. The ECS service ensures the desired number of tasks are always running.

## Testing

After deployment, you can test your service by:

1. Getting the ALB DNS name from the Terraform outputs
2. Visiting `http://<alb-dns-name>` in your browser
3. You should see the configured server text displayed

## Clean up

To destroy all resources created by this module:

```bash
terraform destroy
```

## Learn more

- [AWS ECS Documentation](https://docs.aws.amazon.com/ecs/)
- [Gruntwork ECS Modules](https://github.com/gruntwork-io/terraform-aws-ecs)
- [Application Load Balancer Guide](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/)

