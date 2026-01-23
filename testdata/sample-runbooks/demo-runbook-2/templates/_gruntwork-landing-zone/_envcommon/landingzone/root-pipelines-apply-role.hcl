inputs = {
  allowed_sources = {
    "{{ .SCMProviderGroup }}/{{ .SCMProviderRepo }}" : ["main"]
  }

  # Policy for OIDC role assumed from {{ .SCMProvider }} in the "{{ .SCMProviderGroup }}/{{ .SCMProviderRepo }}" repo
  custom_iam_policy_name = "root-pipelines-apply-oidc-policy"
  iam_role_name          = "root-pipelines-apply"

  # This ${{ .SCMProvider }} OIDC IAM role is used by the central infra-live repo, via Pipelines, to deploy
  # changes to child accounts. These permissions should be updated as necessary based on the type of infrastructure
  # contained in the central infra-live repo.
  iam_policy = {
    "IamPassRole" = {
      resources = ["*"]
      actions   = ["iam:*"]
      effect    = "Allow"
    }
    "IamCreateRole" = {
      resources = [
        "arn:{{ .AWSPartition }}:iam::*:role/aws-service-role/orgsdatasync.servicecatalog.amazonaws.com/AWSServiceRoleForServiceCatalogOrgsDataSync"
      ]
      actions = ["iam:CreateServiceLinkedRole"]
      effect  = "Allow"
    }
    "S3BucketAccess" = {
      resources = ["*"]
      actions   = ["s3:*"]
      effect    = "Allow"
    }
    "StatesDeployAccess" = {
      resources = ["*"]
      actions   = ["states:*"]
      effect    = "Allow"
    }
    "DynamoDBLocksTableAccess" = {
      resources = ["arn:{{ .AWSPartition }}:dynamodb:*:*:table/terraform-locks"]
      actions   = ["dynamodb:*"]
      effect    = "Allow"
    }
    "OrganizationsDeployAccess" = {
      resources = ["*"]
      actions   = ["organizations:*"]
      effect    = "Allow"
    }
    "ControlTowerDeployAccess" = {
      resources = ["*"]
      actions   = ["controltower:*"]
      effect    = "Allow"
    }
    "IdentityCenterDeployAccess" = {
      resources = ["*"]
      actions   = ["sso:*", "ds:*", "sso-directory:*"]
      effect    = "Allow"
    }
    "ECSDeployAccess" = {
      resources = ["*"]
      actions   = ["ecs:*"]
      effect    = "Allow"
    }
    "ACMDeployAccess" = {
      resources = ["*"]
      actions   = ["acm:*"]
      effect    = "Allow"
    }
    "AutoScalingDeployAccess" = {
      resources = ["*"]
      actions   = ["autoscaling:*"]
      effect    = "Allow"
    }
    "CloudTrailDeployAccess" = {
      resources = ["*"]
      actions   = ["cloudtrail:*"]
      effect    = "Allow"
    }
    "CloudWatchDeployAccess" = {
      resources = ["*"]
      actions   = ["cloudwatch:*", "logs:*"]
      effect    = "Allow"
    }
    "CloudFrontDeployAccess" = {
      resources = ["*"]
      actions   = ["cloudfront:*"]
      effect    = "Allow"
    }
    "ConfigDeployAccess" = {
      resources = ["*"]
      actions   = ["config:*"]
      effect    = "Allow"
    }
    "EC2DeployAccess" = {
      resources = ["*"]
      actions   = ["ec2:*"]
      effect    = "Allow"
    }
    "ECRDeployAccess" = {
      resources = ["*"]
      actions   = ["ecr:*"]
      effect    = "Allow"
    }
    "ELBDeployAccess" = {
      resources = ["*"]
      actions   = ["elasticloadbalancing:*"]
      effect    = "Allow"
    }
    "GuardDutyDeployAccess" = {
      resources = ["*"]
      actions   = ["guardduty:*"]
      effect    = "Allow"
    }
    "IAMDeployAccess" = {
      resources = ["*"]
      actions   = ["iam:*", "access-analyzer:*"]
      effect    = "Allow"
    }
    "KMSDeployAccess" = {
      resources = ["*"]
      actions   = ["kms:*"]
      effect    = "Allow"
    }
    "LambdaDeployAccess" = {
      resources = ["*"]
      actions   = ["lambda:*"]
      effect    = "Allow"
    }
    "Route53DeployAccess" = {
      resources = ["*"]
      actions   = ["route53:*", "route53domains:*", "route53resolver:*"]
      effect    = "Allow"
    }
    "SecretsManagerDeployAccess" = {
      resources = ["*"]
      actions   = ["secretsmanager:*"]
      effect    = "Allow"
    }
    "SNSDeployAccess" = {
      resources = ["*"]
      actions   = ["sns:*"]
      effect    = "Allow"
    }
    "SQSDeployAccess" = {
      resources = ["*"]
      actions   = ["sqs:*"]
      effect    = "Allow"
    }
    "SecurityHubDeployAccess" = {
      resources = ["*"]
      actions   = ["securityhub:*"]
      effect    = "Allow"
    }
    "MacieDeployAccess" = {
      resources = ["*"]
      actions   = ["macie2:*"]
      effect    = "Allow"
    }
    "ServiceQuotaDeployAccess" = {
      resources = ["*"]
      actions   = ["servicequotas:*"]
      effect    = "Allow"
    }
    "EKSAccess" = {
      resources = ["*"]
      actions   = ["eks:*"]
      effect    = "Allow"
    }
    "EventBridgeAccess" = {
      resources = ["*"]
      actions   = ["events:*"]
      effect    = "Allow"
    }
    "ApplicationAutoScalingAccess" = {
      resources = ["*"]
      actions   = ["application-autoscaling:*"]
      effect    = "Allow"
    }
    "ApiGatewayAccess" = {
      resources = ["*"]
      actions   = ["apigateway:*"]
      effect    = "Allow"
    }
  }
}
