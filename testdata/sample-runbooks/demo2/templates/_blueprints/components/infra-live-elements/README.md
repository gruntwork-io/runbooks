# {{ .SCMProviderRepo }}

The infrastructure in this repo is managed as **code** using [Terragrunt](https://terragrunt.gruntwork.io/), a thin wrapper around [Terraform](https://www.terraform.io). Most of the infrastructure code in this repository use:

- [Gruntwork IaC Library](https://gruntwork.io/infrastructure-as-code-library/)
- [Gruntwork Service Catalog](https://github.com/gruntwork-io/terraform-aws-service-catalog)

## Directory structure

The code in this `infrastructure-live` repository organizes your Terraform modules in a hierarchy designed to be easy to navigate and scale.

You should follow this pattern when using _any_ Terraform modules:

```tree
.
├── root.hcl                                # the "root" terragrunt.hcl file
├── common.hcl
├── accounts.yml
├── _envcommon
│   └── Category
│       └── Terraform-Module-X.hcl                # all Terraform-Module-X's inherit this file.
└── Account
    ├── Region
    │   ├── Environment
    │   │   └── Category
    │   │       └── Terraform-Module-X-v2.0
    │   │          └── terragrunt.hcl             # a "leaf" terragrunt.hcl file.
    │   └── _regional
    │       └── Terraform-Module-Y-v3.0
    │           └── terragrunt.hcl                # each "leaf" calls a single Terraform module.
    └── _global
        └── Terraform-Module-Z-v4.0
            └── terragrunt.hcl                    # except, much DRYer than regular Terraform.
        └── ...
```

The standard files and folders in the infrastructure-live Terragrunt pattern are:

- **`root.hcl`**: This file lives in the root of this repository and contains the Terraform configuration and input values that are common in all of your environments. Using Terragrunt this way allows us to scale in a standardized way by keeping the following DRY:
  - The Terraform provider block for configuring access to AWS.
  - The Terraform remote state configuration for storing the state data in AWS S3 buckets.
  - A minimal set of global inputs that are needed by all resources.
- **`common.hcl`**: A Terragrunt data file that defines global local variables that every module called by a Terragrunt configuration needs to reference.
- **`accounts.yml`**: A YAML data file that contains a mapping of account names to metadata about the AWS account. This file defines the AWS account ID and root user email in-code.
- **`tags.yml`**: YAML data files that contain a mapping of key-value pairs to use as tags on all AWS resources.
  More information on tagging can be found in the [Tagging](#tagging) section below.
- **`_envcommon`**: This directory contains Terragrunt configuration that can be shared across all the Terraform modules being called in each environment.

  - One analogy is to think about module defaults(\_envcommon) in the same way you might think about purchasing a new car. The manufacturer offers a "base model" with several configurable options, such as interior upgrades, but at the end of the purchase you will have a car. As the purchaser, you might just need the base model without any upgrades, or you may upgrade the stereo to a premium option.

  Similarly, with module defaults you may define a "base" resource, such as an AWS RDS for PostgreSQL instance. By default, all consumers of the module might get a `db.t3.medium` instance with a `50gb` general purpose SSD. While this might work in the majority of your environments, for a production deployment you might need an instance with more memory, CPU, and storage space. With module defaults, you would simply override the variable names for the instance size/type and the amount of desired storage. Everything else remains the same.

- `Account`: At the top level are each of your AWS accounts, such as `stage`, `prod`, `security`, etc.
  - There is a `_global` folder in this directory that defines resources that are available across all the AWS regions in this account, such as Identity and Access Management (IAM) Users, Route 53 hosted zones, and CloudTrail.
- `Region`: Within each `Account` directory, there's one or more folders representing [AWS regions](http://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-regions-availability-zones.html), such as `us-east-1`, `eu-west-1`, and `ap-southeast-2`, mapping to where you've deployed resources.
  - There is a `_regional` folder that defines resources available across all the environments in this AWS region, such as Route 53 A records, Simple Notification Service (SNS) topics, and Elastic Container Registry (ECR) repositories.
- `Environment`: Within each `Region` directory, there will be one or more environments, such as `data-science-team`, `web-apps`, `mgmt`, etc.
  - Typically, an environment will correspond to a single [AWS Virtual Private Cloud (VPC)](https://aws.amazon.com/vpc/), which isolates that environment from everything else in that AWS account.
- `Category`: Within each `Environment`, you deploy all the resources for that environment, such as EKS clusters and Aurora databases, using Terraform modules. Groups or similar modules inside an environment are further organized by the overarching category they relate to, such as `networking` (VPCs) and `services` (EKS workers).

  - Note that the Terraform code for most of these resources lives in the [terraform-aws-service-catalog repo](https://github.com/gruntwork-io/terraform-aws-service-catalog).

    - Many Terraform modules will live inside a `Category` directory. Here's a real-world example of the contents of two different `Category` directories:

      ```bash
      ~/tf/infrastructure-live/production/us-east-2/production 0 $ tree networking
      networking
      ├── openvpn-server
      │   ├── README.md
      │   └── terragrunt.hcl
      ├── route53-private
      │   ├── README.md
      │   └── terragrunt.hcl
      └── vpc
          └── terragrunt.hcl

      3 directories, 5 files
      ~/tf/infrastructure-live/production/us-east-2/production 0 $ tree data-stores
      data-stores
      ├── aurora
      │   ├── README.md
      │   └── terragrunt.hcl
      └── redis
          ├── README.md
          └── terragrunt.hcl

      2 directories, 4 files
      ~/tf/infrastructure-live/production/us-east-2/production 0 $ tree services
      services
      ├── eks-applications-namespace
      │   ├── README.md
      │   └── terragrunt.hcl
      ├── eks-cluster
      │   ├── README.md
      │   └── terragrunt.hcl
      ├── eks-core-services
      │   ├── README.md
      │   └── terragrunt.hcl
      ├── sample-app-backend
      │   ├── README.md
      │   └── terragrunt.hcl
      └── sample-app-frontend
          ├── README.md
          └── terragrunt.hcl

      5 directories, 10 files
      ```

- `Terraform-Module`: Within each `Category` directory, we reach the end of our hierarchy. The folders corresponding to Terraform modules we want to deploy containing our leaf `terragrunt.hcl` files, or if we do not want to use Terragrunt templating, our standard Terraform `main.tf`, etc., files.
  - If you need to do regular Terraform work, you can always write standard Terraform and then refactor it at a later date to match the layout of the modules that Gruntwork configured for you initially. The only modification required would be adding an empty `terragrunt.hcl` in your Terraform root module.
  - This ability to mix-and-match is made possible because the Terragrunt binary can be a drop-in replacement for Terraform. In any existing Terraform modules you have today, you could download Terragrunt and swap out `terraform apply` for `terragrunt apply`; you'll just need to make sure you `touch terragrunt.hcl` in any existing Terraform root modules.

### Why are all the accounts, regions, and environments in separate folders?

The reason we keep each account, region, and environment in separate Terraform templates in separate folders is for **isolation**. This reduces the chances that when you're fiddling in, say, the staging environment in `us-west-2`, you accidentally break something in the production environment in `us-east-1`. In fact, our setup also ensures that Terraform will store the [state of your infrastructure](https://www.terraform.io/docs/state/) in separate files for each environment too, so in the (very rare) case that you totally corrupt your state in the stage environment, your production environment should keep running just fine.

This is why we recommend the following golden rule: **ALWAYS TEST YOUR CHANGES IN STAGE FIRST**. It's safe, easy, and it will save you a lot of time & pain.

## How do you apply changes to this infrastructure?

Each folder contains a `terragrunt.hcl` configuration that defines which Terraform module to deploy with what inputs. To deploy changes to any module:

- With [Gruntwork Pipelines](https://docs.gruntwork.io/2.0/docs/pipelines/tutorials/deploying-your-first-infrastructure-change); create a pull request in this `infrastructure-live` repository with your changes and have the configured pipelines apply your changes.
- Run `terragrunt apply` manually in any of the resource folders.

### Tagging

By default one `tags.yml` file will be placed at the root of this repository, and one `tags.yml` file will be placed in
each account folder. Using these `yaml` files is the primary way in which tags are controlled for all resources
provisioned by this repository. You can use up to three `tags.yml` files to determine the tags for your resources,
based on the following precedence:

1. `tags.yml` directly in the folder where a module is defined.
2. `tags.yml` in the account folder where an account is defined.
3. `tags.yml` at the root of the repository.

So, in a file structure like the following:

```tree
.
├── <account>
│   ├── tags.yml
│   └── region
│       └── <category>
│           └── <module>
│               ├── tags.yml
│               └── terragrunt.hcl
├── tags.yml
└── terragrunt.hcl
```

The initial `tags.yml` at the root of the repository will be used to determine the default tags for all resources
provisioned within the repository. Use this file to define tags that should be applied to all resources, like billing
code or team name.

The `tags.yml` in the account folder will define any tags that are specific to that account, and override any tags that
are also defined in the root `tags.yml`. Use this file to define tags that should be applied to all resources within
a particular account, like the canonical `Environment` tag used by your organization, or any tags indicate production
usage, etc.

Finally, the `tags.yml` in the module folder will define any tags that are specific to that module, and override any
tags that are also defined in the account `tags.yml` or the root `tags.yml`. By default, there will be no `tags.yml`
defined in the module folder, but feel free to introduce one if you need to specify tags that are specific to
a particular service, etc.
