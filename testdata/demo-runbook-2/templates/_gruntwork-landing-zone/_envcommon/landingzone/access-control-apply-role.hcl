locals {
  # Automatically load account-level variables
  account_vars         = read_terragrunt_config(find_in_parent_folders("account.hcl"))
  state_bucket_pattern = local.account_vars.locals.state_bucket_pattern
}

inputs = {
  allowed_sources = {
    "{{ .SCMProviderGroup }}/{{ .AccessControlRepoName }}" : ["main"]
  }

  custom_iam_policy_name = "access-control-pipelines-apply-oidc-policy"
  iam_role_name          = "access-control-pipelines-apply"

  iam_policy = {
    # State permissions
    "DynamoDBLocksTableAccess" = {
      effect = "Allow"
      actions = [
        "dynamodb:PutItem",
        "dynamodb:GetItem",
        "dynamodb:DescribeTable",
        "dynamodb:DeleteItem",
        "dynamodb:CreateTable",
      ]
      resources = ["arn:{{ .AWSPartition }}:dynamodb:*:*:table/terraform-locks"]
    }
    "S3StateBucketAccess" = {
      effect = "Allow"
      actions = [
        "s3:ListBucket",
        "s3:GetBucketVersioning",
        "s3:GetBucketAcl",
        "s3:GetBucketLogging",
        "s3:CreateBucket",
        "s3:PutBucketPublicAccessBlock",
        "s3:PutBucketTagging",
        "s3:PutBucketPolicy",
        "s3:PutBucketVersioning",
        "s3:PutEncryptionConfiguration",
        "s3:PutBucketAcl",
        "s3:PutBucketLogging",
        "s3:GetEncryptionConfiguration",
        "s3:GetBucketPolicy",
        "s3:GetBucketPublicAccessBlock",
        "s3:PutLifecycleConfiguration",
        "s3:PutBucketOwnershipControls",
      ]
      resources = [
        "arn:{{ .AWSPartition }}:s3:::${local.state_bucket_pattern}",
      ]
    }
    "S3StateBucketObjectAccess" = {
      effect = "Allow"
      actions = [
        "s3:PutObject",
        "s3:GetObject"
      ]
      resources = [
        "arn:{{ .AWSPartition }}:s3:::${local.state_bucket_pattern}/*",
      ]
    }
    # Role permissions
    "IAMAllAccess" = {
      effect = "Allow"
      actions = [
        "iam:*",
      ]
      resources = ["*"]
    }
  }
}
