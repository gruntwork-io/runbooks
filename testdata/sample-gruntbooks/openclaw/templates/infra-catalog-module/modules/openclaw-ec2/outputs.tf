output "instance_id" {
  value       = aws_instance.openclaw.id
  description = "The ID of the OpenClaw EC2 instance"
}

output "vpc_id" {
  value       = aws_vpc.openclaw.id
  description = "The ID of the VPC"
}

output "ssm_connect_command" {
  value       = "aws ssm start-session --target ${aws_instance.openclaw.id}"
  description = "Command to open a shell on the instance via SSM Session Manager"
}

output "ssm_port_forward_command" {
  value       = "aws ssm start-session --target ${aws_instance.openclaw.id} --document-name AWS-StartPortForwardingSession --parameters '{\"portNumber\":[\"${var.gateway_port}\"],\"localPortNumber\":[\"${var.gateway_port}\"]}'"
  description = "Command to forward the OpenClaw port to localhost via SSM"
}

output "openclaw_url" {
  value       = "http://localhost:${var.gateway_port}"
  description = "URL to access OpenClaw after starting the SSM port forward"
}

output "password_retrieval_command" {
  value       = "aws ssm start-session --target ${aws_instance.openclaw.id} --document-name AWS-StartInteractiveCommand --parameters command='sudo cat /home/ubuntu/.openclaw-password'"
  description = "Command to retrieve the OpenClaw gateway password via SSM"
}
