#!/bin/bash
# List AWS resources using the authenticated credentials

set -e

echo "=== AWS Account Information ==="
aws sts get-caller-identity --output yaml

echo ""
echo "=== S3 Buckets ==="
aws s3 ls || echo "No S3 buckets found or insufficient permissions"

echo ""
echo "=== EC2 Instances (current region: ${AWS_REGION:-us-east-1}) ==="
aws ec2 describe-instances --query 'Reservations[].Instances[].[InstanceId,State.Name,InstanceType]' --output table || echo "No EC2 instances found or insufficient permissions"

echo ""
echo "Done!"

