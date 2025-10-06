locals {
  # Automatically load account-level variables
  account_vars         = read_terragrunt_config(find_in_parent_folders("account.hcl"))
  state_bucket_pattern = local.account_vars.locals.state_bucket_pattern
}

inputs = {
  allowed_sources_condition_operator = "StringLike"

  allowed_sources = {
    "{{ .SCMProviderGroup }}/{{ .SCMProviderRepo }}" : ["*"]
  }

  # Policy for OIDC role assumed from {{ .SCMProvider }} in the "{{ .SCMProviderGroup }}/{{ .SCMProviderRepo }}" repo
  custom_iam_policy_name = "root-pipelines-plan-oidc-policy"
  iam_role_name          = "root-pipelines-plan"

  # This {{ .SCMProvider }} OIDC IAM role is used by the central infra-live repo, via Pipelines, to plan
  # changes to child accounts. These permissions should be updated as necessary based on the type of infrastructure
  # contained in the central infra-live repo.
  iam_policy = {
    "RDSReadOnlyAccess" = {
      effect = "Allow"
      actions = [
        "rds:Describe*",
        "rds:List*",
        "rds:Download*",
      ]
      resources = ["*"]
    }
    "CloudWatchEventsReadOnlyAccess" = {
      effect    = "Allow"
      actions   = ["events:Describe*", "events:List*"]
      resources = ["*"]
    }
    ECSReadOnlyAccess = {
      effect = "Allow"
      actions = [
        "ecs:Describe*",
        "ecs:List*",
      ]
      resources = ["*"]
    }
    "ACMReadOnlyAccess" = {
      effect = "Allow"
      actions = [
        "acm:DescribeCertificate",
        "acm:ListCertificates",
        "acm:GetCertificate",
        "acm:ListTagsForCertificate",
      ]
      resources = ["*"]
    }
    AutoScalingReadOnlyAccess = {
      effect    = "Allow"
      actions   = ["autoscaling:Describe*"]
      resources = ["*"]
    }
    "CloudTrailReadOnlyAccess" = {
      effect = "Allow"
      actions = [
        "cloudtrail:Describe*",
        "cloudtrail:List*",
        "cloudtrail:Get*",
      ]
      resources = ["*"]
    }
    "CloudWatchReadOnlyAccess" = {
      effect    = "Allow"
      actions   = ["cloudwatch:Describe*", "cloudwatch:List*"]
      resources = ["*"]
    }
    "CloudWatchLogsReadOnlyAccess" = {
      effect = "Allow"
      actions = [
        "logs:Get*",
        "logs:Describe*",
        "logs:List*",
        "logs:Filter*",
        "logs:ListTagsLogGroup"
      ]
      resources = ["*"]
    }
    "ConfigReadOnlyAccess" = {
      effect = "Allow"
      actions = [
        "config:Get*",
        "config:Describe*",
        "config:List*",
        "config:Select*",
        "config:BatchGetResourceConfig",
      ]
      resources = ["*"]
    }
    "EC2ServiceReadOnlyAccess" = {
      effect = "Allow"
      actions = [
        "ec2:Describe*",
        "ec2:Get*",
      ]
      resources = ["*"]
    }
    "ECRReadOnlyAccess" = {
      effect = "Allow"
      actions = [
        "ecr:BatchGet*",
        "ecr:Describe*",
        "ecr:Get*",
        "ecr:List*",
      ]
      resources = ["*"]
    }
    "ELBReadOnlyAccess" = {
      effect    = "Allow"
      actions   = ["elasticloadbalancing:Describe*"]
      resources = ["*"]
    }
    "StatesReadOnlyAccess" = {
      resources = ["*"]
      actions   = [
        "states:List*",
        "states:Describe*",
        "states:GetExecutionHistory",
        "states:ValidateStateMachineDefinition"
      ]
      effect    = "Allow"
    }
    "GuardDutyReadOnlyAccess" = {
      effect = "Allow"
      actions = [
        "guardduty:Get*",
        "guardduty:List*",
      ]
      resources = ["*"]
    }
    "IAMReadOnlyAccess" = {
      effect = "Allow"
      actions = [
        "iam:Get*",
        "iam:List*",
        "iam:PassRole*",
      ]
      resources = ["*"]
    }
    "IAMAccessAnalyzerReadOnlyAccess" = {
      effect = "Allow"
      actions = [
        "access-analyzer:List*",
        "access-analyzer:Get*",
        "access-analyzer:ValidatePolicy",
      ]
      resources = ["*"]
    }
    "KMSReadOnlyAccess" = {
      effect = "Allow"
      actions = [
        "kms:Describe*",
        "kms:Get*",
        "kms:List*",
      ]
      resources = ["*"]
    }
    "LambdaReadOnlyAccess" = {
      effect = "Allow"
      actions = [
        "lambda:Get*",
        "lambda:List*",
        "lambda:InvokeFunction"
      ]
      resources = ["*"]
    }
    "Route53ReadOnlyAccess" = {
      effect = "Allow"
      actions = [
        "route53:Get*",
        "route53:List*",
        "route53:Test*",
        "route53domains:Check*",
        "route53domains:Get*",
        "route53domains:List*",
        "route53domains:View*",
        "route53resolver:Get*",
        "route53resolver:List*",
      ]
      resources = ["*"]
    }
    "S3ReadOnlyAccess" = {
      effect = "Allow"
      actions = [
        "s3:Describe*",
        "s3:Get*",
        "s3:List*",
      ]
      resources = ["*"]
    }
    "SecretsManagerReadOnlyAccess" = {
      effect = "Allow"
      actions = [
        "secretsmanager:Get*",
        "secretsmanager:List*",
        "secretsmanager:Describe*",
      ]
      resources = ["*"]
    }
    "SNSReadOnlyAccess" = {
      effect = "Allow"
      actions = [
        "sns:Get*",
        "sns:List*",
        "sns:Check*",
      ]
      resources = ["*"]
    }
    "SQSReadOnlyAccess" = {
      effect = "Allow"
      actions = [
        "sqs:Get*",
        "sqs:List*",
      ]
      resources = ["*"]
    }
    "DynamoDBLocksTableAccess" = {
      effect = "Allow"
      actions = [
        "dynamodb:*",
      ]
      resources = ["arn:{{ .AWSPartition }}:dynamodb:*:*:table/terraform-locks"]
    }
    "S3StateBucketAccess" = {
      effect = "Allow"
      actions = [
        "s3:*",
      ]
      resources = [
        "arn:{{ .AWSPartition }}:s3:::${local.state_bucket_pattern}",
        "arn:{{ .AWSPartition }}:s3:::${local.state_bucket_pattern}/*",
      ]
    }
    "SecurityHubDeployAccess" = {
      resources = ["*"]
      actions = [
        "securityhub:Get*",
        "securityhub:Describe*",
        "securityhub:List*"
      ]
      effect = "Allow"
    }
    "MacieDeployAccess" = {
      resources = ["*"]
      actions = [
        "macie2:Get*",
        "macie2:Describe*",
        "macie2:List*"
      ]
      effect = "Allow"
    }
    "ServiceQuotaAccess" = {
      resources = ["*"]
      actions = [
        "servicequotas:Get*",
        "servicequotas:List*"
      ]
      effect = "Allow"
    }
    "ApplicationAutoScalingAccess" = {
      resources = ["*"]
      actions = [
        "application-autoscaling:Describe*",
        "application-autoscaling:List*"
      ]
      effect = "Allow"
    }
    "ApiGatewayAccess" = {
      resources = ["*"]
      actions   = ["apigateway:Get*"]
      effect    = "Allow"
    }
  }
}
