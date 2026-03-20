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

output "tailscale_access_note" {
  value       = "Access OpenClaw at http://<tailscale-ip>:${var.gateway_port} — run 'tailscale status' to find the Tailscale IP of '${var.instance_name}'"
  description = "Instructions for accessing OpenClaw via Tailscale"
}

output "token_retrieval_command" {
  value       = "aws ssm start-session --target ${aws_instance.openclaw.id} --document-name AWS-StartInteractiveCommand --parameters command='cat /home/ubuntu/.openclaw-token'"
  description = "Command to retrieve the OpenClaw gateway auth token via SSM"
}
