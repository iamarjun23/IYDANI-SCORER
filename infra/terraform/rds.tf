# The database.
#
# READ THIS BEFORE CHANGING ANY OF IT — the networking here is a deliberate
# dev-stage trade, not an oversight.
#
# Lambda sits OUTSIDE the VPC and this instance is PUBLICLY ADDRESSABLE. The
# alternative — Lambda inside the VPC, RDS private — is the correct production
# shape and is what `var.private_networking = true` moves toward, but a Lambda
# in a VPC has no route to the internet without a NAT, and the API must reach
# two public services to function at all: Cognito's JWKS endpoint (to verify
# every request's token) and Razorpay (to take a payment). A NAT gateway is
# ~$32/month — several times this entire stack at dev scale — and a NAT
# instance is an EC2 box somebody has to patch.
#
# So what protects this instance in the meantime is NOT the network:
#   - a 32-character generated password that exists only in Secrets Manager,
#   - force_ssl, so a connection that is not TLS is refused outright,
#   - and `db_allowed_cidrs`, which SHOULD be narrowed to known addresses the
#     moment they are known. It defaults open because the Lambda's egress IPs
#     are not fixed without the NAT this is avoiding.
#
# Exposed Postgres gets port-scanned continuously. This is acceptable for a dev
# stack holding test scores and test bookings; it is NOT acceptable once one
# real person's data is in it. The graduation is: NAT (instance or gateway),
# `publicly_accessible = false`, Lambda gets vpc_config, SG source becomes the
# Lambda SG instead of a CIDR list.

resource "random_password" "db" {
  length = 32
  # RDS refuses /, @, ", and space in a master password, and a password that
  # gets rejected at create time surfaces as a confusing Terraform error rather
  # than as a password rule.
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

resource "aws_db_subnet_group" "main" {
  name       = "${local.name_prefix}-db"
  subnet_ids = data.aws_subnets.default.ids
}

resource "aws_security_group" "db" {
  name        = "${local.name_prefix}-db"
  description = "Postgres access for the IYDANI API"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "Postgres"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = var.db_allowed_cidrs
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# force_ssl is set through a parameter group rather than an instance argument —
# there is no instance-level flag for it, and without it Postgres will happily
# accept a cleartext connection from anywhere the security group allows.
resource "aws_db_parameter_group" "main" {
  name   = "${local.name_prefix}-pg16"
  family = "postgres16"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
}

resource "aws_db_instance" "main" {
  identifier     = "${local.name_prefix}-db"
  engine         = "postgres"
  engine_version = "16.4"

  instance_class        = var.db_instance_class
  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = 100
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = "iydani"
  username = var.db_username
  password = random_password.db.result
  port     = 5432

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  parameter_group_name   = aws_db_parameter_group.main.name
  publicly_accessible    = true

  # Single-AZ on purpose: multi-AZ doubles the bill and buys failover this stack
  # has no uptime commitment to justify yet.
  multi_az = false

  backup_retention_period = var.environment == "prod" ? 14 : 7
  backup_window           = "18:00-19:00"
  maintenance_window      = "Mon:19:30-Mon:20:30"

  auto_minor_version_upgrade = true
  apply_immediately          = var.environment != "prod"

  # A dev database that cannot be destroyed is a dev database that becomes
  # permanent by accident. Prod keeps the guard and takes a final snapshot.
  deletion_protection       = var.environment == "prod"
  skip_final_snapshot       = var.environment != "prod"
  final_snapshot_identifier = var.environment == "prod" ? "${local.name_prefix}-final" : null

  performance_insights_enabled = false
  monitoring_interval          = 0
}

# Built once, used by both paths in secrets.tf / lambda.tf — the free-tier dev
# path (a plain Lambda env var) and the Secrets Manager path need the identical
# string, and typing it twice is how the two drift.
#
# sslmode=require, because rds.force_ssl (aws_db_parameter_group.main above)
# refuses the connection otherwise, and node-postgres's default is not to
# require TLS.
locals {
  db_url = "postgresql://${var.db_username}:${urlencode(random_password.db.result)}@${aws_db_instance.main.endpoint}/${aws_db_instance.main.db_name}?sslmode=require"
}
