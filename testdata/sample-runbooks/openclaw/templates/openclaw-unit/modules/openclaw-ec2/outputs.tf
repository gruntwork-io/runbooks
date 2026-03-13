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

output "private_key_openssh" {
  value       = tls_private_key.openclaw.private_key_openssh
  sensitive   = true
  description = "Private SSH key in OpenSSH format. Save to ~/.ssh/${var.instance_name}-key and chmod 600."
}

output "save_key_instructions" {
  value       = "Run: terragrunt output -raw private_key_openssh > ~/.ssh/${var.instance_name}-key && chmod 600 ~/.ssh/${var.instance_name}-key"
  description = "Command to save the private key to your local machine"
}

output "ssh_command" {
  value       = "ssh -i ~/.ssh/${var.instance_name}-key ubuntu@${aws_eip.openclaw.public_ip}"
  description = "SSH command to connect to the instance"
}

output "tailscale_access_note" {
  value       = "Access OpenClaw at http://<tailscale-ip>:${var.gateway_port} — run 'tailscale status' to find the Tailscale IP of '${var.instance_name}'"
  description = "Instructions for accessing OpenClaw via Tailscale"
}

output "token_retrieval_command" {
  value       = "ssh -i ~/.ssh/${var.instance_name}-key ubuntu@${aws_eip.openclaw.public_ip} cat /home/ubuntu/.openclaw-token"
  description = "Command to retrieve the OpenClaw gateway auth token"
}
