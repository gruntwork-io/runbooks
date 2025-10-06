output "alb_dns_name" {
  description = "The DNS name of the Application Load Balancer"
  value       = module.alb.alb_dns_name
}

output "alb_security_group_id" {
  description = "The ID of the ALB security group"
  value       = module.alb.alb_security_group_id
}

output "ecs_cluster_arn" {
  description = "The ARN of the ECS cluster"
  value       = module.ecs_cluster.ecs_cluster_arn
}

output "ecs_service_name" {
  description = "The name of the ECS service"
  value       = module.ecs_service.service_name
}

output "http_listener_arns" {
  description = "The ARNs of the HTTP listeners"
  value       = module.alb.http_listener_arns
}

output "s3_test_bucket_name" {
  description = "The name of the S3 test bucket"
  value       = aws_s3_bucket.s3_test_bucket.id
}

