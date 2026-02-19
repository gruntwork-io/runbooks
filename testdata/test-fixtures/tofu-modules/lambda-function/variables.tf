variable "function_name" {
  type        = string
  description = "Name of the Lambda function"
}

variable "runtime" {
  type        = string
  description = "Lambda runtime"
  validation {
    condition     = contains(["python3.13", "python3.12", "nodejs22.x", "nodejs20.x"], var.runtime)
    error_message = "Runtime must be one of: python3.13, python3.12, nodejs22.x, nodejs20.x"
  }
}

variable "handler" {
  type        = string
  default     = "index.handler"
  description = "Function entrypoint"
}

variable "description" {
  type        = string
  default     = ""
  description = "Description of the Lambda function"
}
