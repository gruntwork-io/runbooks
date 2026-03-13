output "instance_id" {
  value       = aws_instance.openclaw.id
  description = "The ID of the OpenClaw EC2 instance"
}

output "public_ip" {
  value       = aws_eip.openclaw.public_ip
  description = "The Elastic IP address of the instance (for SSH access)"
}

output "vpc_id" {
  value       = aws_vpc.openclaw.id
  description = "The ID of the VPC"
}

output "ssh_command" {
  value       = "ssh -i ~/.ssh/${var.key_pair_name}.pem ubuntu@${aws_eip.openclaw.public_ip}"
  description = "SSH command to connect to the instance"
}

output "tailscale_access_note" {
  value       = "Access OpenClaw at http://<tailscale-ip>:${var.gateway_port} — run 'tailscale status' to find the Tailscale IP of '${var.instance_name}'"
  description = "Instructions for accessing OpenClaw via Tailscale"
}

output "token_retrieval_command" {
  value       = "ssh -i ~/.ssh/${var.key_pair_name}.pem ubuntu@${aws_eip.openclaw.public_ip} cat /home/ubuntu/.openclaw-token"
  description = "Command to retrieve the OpenClaw gateway auth token"
}
