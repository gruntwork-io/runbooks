# Launch a Lambda Function URL

## What is a Lambda Function URL?

A function URL is a dedicated HTTP(S) endpoint for your Lambda function. When you create a function URL, Lambda automatically generates a unique URL endpoint for you. Once you create a function URL, its URL endpoint never changes. Function URL endpoints have the following format:

```
https://<url-id>.lambda-url.<region>.on.aws
```

## Prerequisites

1. The Lambda function for which you want to add a URL already exists.

### Origin Access Control (OAC)

This function generate an OAC for cloudfront distribution. This will allow users to have custom domains, and scalably expose function URL accessible Lambdas to end users, leveraging functionality in CloudFront.
After Successful OAC creation, you can select this oac while Cloudfront distribution creation.

## Configure your Lambda Function URL

WEBFORM - Generates a Terragrunt unit 
WEBFORM - Generates an OpenTofu module call

Check: Hit the endpoint and make sure it returns HTTP 200 OK.

## Deploy instructions

1. Install [Terraform](https://www.terraform.io/).
1. Configure your AWS credentials as environment variables: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
   ([instructions](https://blog.gruntwork.io/a-comprehensive-guide-to-authenticating-to-aws-on-the-command-line-63656a686799)).
1. Open [variables.tf](variables.tf) and set all required parameters (plus any others you wish to override). We
   recommend setting these variables in a `terraform.tfvars` file (see
   [here](https://www.terraform.io/docs/configuration/variables.html#assigning-values-to-root-module-variables) for all
   the ways you can set Terraform variables).

   *Note: Ensure that the lambda function name provided is a valid and existing lambda function.* 

1. Run `terraform init`.
1. Run `terraform apply`.
1. The module will output the HTTP URL endpoint for the function in the format, The Amazon Resource Name (ARN) of the function, and generated ID for the endpoint.
1. When you're done testing, to undeploy everything, run `terraform destroy`.
