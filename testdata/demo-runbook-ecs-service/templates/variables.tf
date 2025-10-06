# ---------------------------------------------------------------------------------------------------------------------
# ENVIRONMENT VARIABLES
# Define these secrets as environment variables
# ---------------------------------------------------------------------------------------------------------------------

# AWS_ACCESS_KEY_ID
# AWS_SECRET_ACCESS_KEY

# ---------------------------------------------------------------------------------------------------------------------
# MODULE PARAMETERS
# These variables are expected to be passed in by the operator
# ---------------------------------------------------------------------------------------------------------------------

variable "aws_region" {
  description = "The AWS region in which all resources will be created"
  type        = string
  default     = "{{ .AwsRegion }}"
}

variable "ecs_cluster_name" {
  description = "The name of the ECS cluster"
  type        = string
  default     = "{{ .EcsClusterName }}"
}

variable "ecs_cluster_instance_ami" {
  description = "The AMI to run on each instance in the ECS cluster"
  type        = string
}

variable "ecs_cluster_instance_keypair_name" {
  description = "The name of the Key Pair that can be used to SSH to each instance in the ECS cluster"
  type        = string
}

variable "cluster_instance_type" {
  description = "The instance type to use for the ECS cluster"
  type        = string
  default     = "{{ .ClusterInstanceType }}"
}

variable "container_name" {
  description = "The name of the container in the ECS Task Definition"
  type        = string
  default     = "{{ .ContainerName }}"
}

variable "service_name" {
  description = "The name of the ECS service to run"
  type        = string
  default     = "{{ .ServiceName }}"
}

variable "container_http_port" {
  description = "The port the Docker container listens on for HTTP requests"
  type        = number
  default     = {{ .ContainerHttpPort }}
}

variable "server_text" {
  description = "The Docker container will display this text for every request"
  type        = string
  default     = "{{ .ServerText }}"
}

variable "s3_test_file_name" {
  description = "The name of the file to store in the S3 bucket for testing IAM permissions"
  type        = string
  default     = "s3-test-file.txt"
}

# ---------------------------------------------------------------------------------------------------------------------
# OPTIONAL PARAMETERS
# These variables have defaults and may be overwritten
# ---------------------------------------------------------------------------------------------------------------------

variable "desired_number_of_tasks" {
  description = "How many copies of the task to run across the cluster"
  type        = number
  default     = {{ .DesiredNumberOfTasks }}
}

variable "container_memory" {
  description = "Amount of memory to provision for the container"
  type        = number
  default     = {{ .ContainerMemory }}
}

variable "container_command" {
  description = "Command to run on the container"
  type        = list(string)
  default     = []
}

variable "container_boot_delay_seconds" {
  description = "Delay the boot up sequence of the container by this many seconds"
  type        = number
  default     = 0
}

variable "health_check_grace_period_seconds" {
  description = "How long to wait before having the ALB start checking health"
  type        = number
  default     = {{ .HealthCheckGracePeriod }}
}

variable "health_check_interval" {
  description = "The approximate amount of time, in seconds, between health checks"
  type        = number
  default     = 60
}

variable "wait_for_steady_state" {
  description = "If true, Terraform will wait for the service to reach a steady state"
  type        = bool
  default     = true
}

