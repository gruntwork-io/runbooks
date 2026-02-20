resource "aws_instance" "this" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = var.instance_type
  monitoring    = var.enable_monitoring

  tags = merge(var.tags, {
    Name = var.instance_name
  })
}
