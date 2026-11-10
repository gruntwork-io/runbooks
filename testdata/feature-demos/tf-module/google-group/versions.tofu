language {
  compatible_with {
    opentofu = ">= 1.12.6, < 2.0.0"
  }
}

terraform {
  required_providers {
    google = { source = "hashicorp/google", version = ">= 8.10.0, < 9.0.0" }
  }
}
