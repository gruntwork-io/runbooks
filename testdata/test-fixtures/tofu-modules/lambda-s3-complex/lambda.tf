variable "lambda_function_name" {
  type        = string
  description = "Name of the Lambda function"
}

variable "lambda_runtime" {
  type        = string
  default     = "python3.13"
  description = "Lambda runtime"
  validation {
    condition     = contains(["python3.13", "python3.12", "nodejs22.x", "nodejs20.x"], var.lambda_runtime)
    error_message = "Runtime must be one of: python3.13, python3.12, nodejs22.x, nodejs20.x"
  }
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
