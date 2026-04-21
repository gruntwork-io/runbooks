# ----------------------------------------------------------------------------------------------------------------
# MULTIREGION CONVENIENCE LOCALS
# The following locals are used for constructing multi region provider configurations for the underlying module.
# ----------------------------------------------------------------------------------------------------------------
locals {
  # A list of all AWS regions
  all_aws_regions = [
    "af-south-1",
    "ap-east-1",
    "ap-northeast-1",
    "ap-northeast-2",
    "ap-northeast-3",
    "ap-south-1",
    "ap-southeast-1",
    "ap-southeast-2",
    "ap-southeast-3",
    "ca-central-1",
    "cn-north-1",
    "cn-northwest-1",
    "eu-central-1",
    "eu-north-1",
    "eu-south-1",
    "eu-west-1",
    "eu-west-2",
    "eu-west-3",
    "me-south-1",
    "sa-east-1",
    "us-east-1",
    "us-east-2",
    "us-gov-east-1",
    "us-gov-west-1",
    "us-west-1",
    "us-west-2",
    "me-central-1",
  ]

  # Creates resources in the specified regions. The best practice is to enable multiregion modules in all enabled
  # regions in your AWS account. To get the list of regions enabled in your AWS account, you can use the AWS CLI: aws
  # ec2 describe-regions.
  opt_in_regions = [

    // Uncomment the regions you have enabled in Control Tower. Anytime you enable a region in Control Tower, make sure to update it here.
    #  "eu-north-1",
    #  "ap-south-1",
    #  "eu-west-3",
    #  "eu-west-2",
    #  "eu-west-1",
    #  "ap-northeast-1",
    #  "ap-northeast-2",
    #  "ap-northeast-3",
    #  "sa-east-1",
    #  "ca-central-1",
    #  "ap-southeast-1",
    #  "ap-southeast-2",
    #  "eu-central-1",
    #  "us-east-1",
    #  "us-east-2",
    #  "us-west-1",
    #  "us-west-2",

    # By default, skip regions that are not enabled in most AWS accounts:
    #
    #  "af-south-1",     # Cape Town
    #  "ap-east-1",      # Hong Kong
    #  "eu-south-1",     # Milan
    #  "me-south-1",     # Bahrain
    #  "us-gov-east-1",  # GovCloud
    #  "us-gov-west-1",  # GovCloud
    #  "cn-north-1",     # China
    #  "cn-northwest-1", # China
    #  "me-central-1",   # Middle East
  ]
}
