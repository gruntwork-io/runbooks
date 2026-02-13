variable "lambda_function_name" {
  type        = string
  description = "Name of the Lambda function"
}

variable "lambda_runtime" {
  type        = string
  default     = "python3.13"
  description = "Lambda runtime"
}

variable "lambda_handler" {
  type        = string
  default     = "index.handler"
  description = "Function entrypoint"
}

variable "lambda_memory_size" {
  type        = number
  default     = 128
  description = "Amount of memory in MB"
}
