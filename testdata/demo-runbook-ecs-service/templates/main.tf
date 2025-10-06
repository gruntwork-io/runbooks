# ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
# DEPLOY A DOCKER APP WITH AN APPLICATION LOAD BALANCER IN FRONT OF IT
# These templates show an example of how to run a Docker app on top of Amazon's EC2 Container Service (ECS) with an
# Application Load Balancer (ALB) routing traffic to the app.
# ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

terraform {
  required_version = ">= 1.0.0"
}

# ------------------------------------------------------------------------------
# CONFIGURE OUR AWS CONNECTION
# ------------------------------------------------------------------------------

provider "aws" {
  region = var.aws_region
}

# ---------------------------------------------------------------------------------------------------------------------
# CREATE THE ECS CLUSTER
# ---------------------------------------------------------------------------------------------------------------------

module "ecs_cluster" {
  source = "git::git@github.com:gruntwork-io/terraform-aws-ecs.git//modules/ecs-cluster?ref={{ .ModuleVersion }}"

  cluster_name = var.ecs_cluster_name

  # Make the max size twice the min size to allow for rolling out updates to the cluster without downtime
  cluster_min_size = {{ .ClusterMinSize }}
  cluster_max_size = {{ .ClusterMaxSize }}

  cluster_instance_ami              = var.ecs_cluster_instance_ami
  cluster_instance_type             = var.cluster_instance_type
  cluster_instance_keypair_name     = var.ecs_cluster_instance_keypair_name
  cluster_instance_user_data        = local.user_data
  enable_cluster_container_insights = {{ .EnableContainerInsights }}
  use_imdsv1                        = false

  vpc_id         = data.aws_vpc.default.id
  vpc_subnet_ids = data.aws_subnets.default.ids

  ## This example does not create a NAT, so cluster must have a public IP to reach ECS endpoints
  cluster_instance_associate_public_ip_address = true

  alb_security_group_ids = [module.alb.alb_security_group_id]
}

# Create the User Data script that will run on boot for each EC2 Instance in the ECS Cluster.
locals {
  user_data = templatefile(
    "${path.module}/user-data/user-data.sh",
    {
      ecs_cluster_name = var.ecs_cluster_name
    },
  )
}

# ---------------------------------------------------------------------------------------------------------------------
# CREATE AN ALB TO ROUTE TRAFFIC ACROSS THE ECS TASKS
# Typically, this would be created once for use with many different ECS Services.
# ---------------------------------------------------------------------------------------------------------------------

module "alb" {
  source = "git::git@github.com:gruntwork-io/terraform-aws-load-balancer.git//modules/alb?ref={{ .AlbModuleVersion }}"

  alb_name        = var.service_name
  is_internal_alb = false

  http_listener_ports                    = [80{{ if .EnableAdditionalPort }}, 5000{{ end }}]
  https_listener_ports_and_ssl_certs     = []
  https_listener_ports_and_acm_ssl_certs = []
  ssl_policy                             = "ELBSecurityPolicy-TLS-1-1-2017-01"

  vpc_id         = data.aws_vpc.default.id
  vpc_subnet_ids = data.aws_subnets.default.ids
}

# ---------------------------------------------------------------------------------------------------------------------
# CREATE AN S3 BUCKET FOR TESTING PURPOSES ONLY
# We upload a simple text file into this bucket. The ECS Task will try to download the file and display its contents.
# This is used to verify that we are correctly attaching an IAM Policy to the ECS Task that gives it the permissions to
# access the S3 bucket.
# ---------------------------------------------------------------------------------------------------------------------

resource "aws_s3_bucket" "s3_test_bucket" {
  bucket = "${lower(var.service_name)}-test-s3-bucket"
}

resource "aws_s3_object" "s3_test_file" {
  bucket  = aws_s3_bucket.s3_test_bucket.id
  key     = var.s3_test_file_name
  content = "world!"
}

# ---------------------------------------------------------------------------------------------------------------------
# ATTACH AN IAM POLICY TO THE TASK THAT ALLOWS THE ECS SERVICE TO ACCESS THE S3 BUCKET FOR TESTING PURPOSES
# The Docker container in our ECS Task will need this policy to download a file from an S3 bucket. We use this solely
# to test that the IAM policy is properly attached to the ECS Task.
# ---------------------------------------------------------------------------------------------------------------------

resource "aws_iam_policy" "access_test_s3_bucket" {
  name   = "${var.service_name}-s3-test-bucket-access"
  policy = data.aws_iam_policy_document.access_test_s3_bucket.json
}

data "aws_iam_policy_document" "access_test_s3_bucket" {
  statement {
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.s3_test_bucket.arn}/${var.s3_test_file_name}"]
  }

  statement {
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.s3_test_bucket.arn]
  }
}

resource "aws_iam_policy_attachment" "access_test_s3_bucket" {
  name       = "${var.service_name}-s3-test-bucket-access"
  policy_arn = aws_iam_policy.access_test_s3_bucket.arn
  roles      = [module.ecs_service.ecs_task_iam_role_name]
}

# ---------------------------------------------------------------------------------------------------------------------
# CREATE AN ECS TASK DEFINITION FORMATTED AS JSON TO PASS TO THE ECS SERVICE
# This tells the ECS Service which Docker image to run, how much memory to allocate, and every other aspect of how the
# Docker image should run.
# ---------------------------------------------------------------------------------------------------------------------

locals {
  ecs_task_container_definitions = templatefile(
    "${path.module}/containers/container-definition.json",
    {
      container_name = var.container_name
      image          = "{{ .DockerImage }}"
      version        = "{{ .DockerImageVersion }}"
      server_text    = var.server_text
      aws_region     = var.aws_region
      s3_test_file   = "s3://${aws_s3_bucket.s3_test_bucket.id}/${var.s3_test_file_name}"
      cpu            = {{ .ContainerCpu }}
      memory         = var.container_memory
      container_http_port = var.container_http_port
      command        = "[${join(",", formatlist("\"%s\"", var.container_command))}]"
      boot_delay_seconds = var.container_boot_delay_seconds
    },
  )
}

# ---------------------------------------------------------------------------------------------------------------------
# CREATE THE ECS SERVICE
# In Amazon ECS, Docker containers are run as "ECS Tasks", typically as part of an "ECS Service".
# ---------------------------------------------------------------------------------------------------------------------

module "ecs_service" {
  source = "git::git@github.com:gruntwork-io/terraform-aws-ecs.git//modules/ecs-service?ref={{ .ModuleVersion }}"

  service_name = var.service_name
  launch_type  = "EC2"

  ecs_cluster_arn                = module.ecs_cluster.ecs_cluster_arn
  ecs_task_container_definitions = local.ecs_task_container_definitions

  desired_number_of_tasks = var.desired_number_of_tasks

  health_check_grace_period_seconds = var.health_check_grace_period_seconds

  elb_target_groups = {
    alb = {
      name                  = var.service_name
      container_name        = var.container_name
      container_port        = var.container_http_port
      protocol              = "HTTP"
      health_check_protocol = "HTTP"
    }
  }
  elb_target_group_vpc_id = data.aws_vpc.default.id
  elb_slow_start          = 30

  use_auto_scaling      = false
  health_check_interval = var.health_check_interval

  # Make sure all the ECS cluster and ALB resources are deployed before deploying any ECS service resources.
  depends_on = [module.ecs_cluster, module.alb]

  # Explicit dependency to aws_alb_listener_rules to make sure listeners are created before deploying any ECS services
  listener_rule_ids = [
    aws_alb_listener_rule.path_based_example.id
  ]

  wait_for_steady_state = var.wait_for_steady_state
}

# ---------------------------------------------------------------------------------------------------------------------
# CREATE THE ALB LISTENER RULES ASSOCIATED WITH THIS ECS SERVICE
# When an HTTP request is received by the ALB, how will the ALB know to route that request to this particular ECS Service?
# The answer is that we define ALB Listener Rules that can route a request to a specific "Target Group".
# ---------------------------------------------------------------------------------------------------------------------

# Path-based Listener Rule
resource "aws_alb_listener_rule" "path_based_example" {
  listener_arn = module.alb.http_listener_arns["80"]

  priority = 100

  action {
    type             = "forward"
    target_group_arn = module.ecs_service.target_group_arns["alb"]
  }

  condition {
    path_pattern {
      values = ["/*"]
    }
  }
}

# --------------------------------------------------------------------------------------------------------------------
# GET VPC AND SUBNET INFO FROM TERRAFORM DATA SOURCE
# --------------------------------------------------------------------------------------------------------------------

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "default-for-az"
    values = [true]
  }
}

