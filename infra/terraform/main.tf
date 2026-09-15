# IYDANI backend infrastructure.
#
# Deliberately trimmed against docs/roadmap/AWS-INFRASTRUCTURE.md: no VPC of our
# own, no ECS, no ElastiCache, no CloudFront, no WAF. Those are all real answers
# to problems this deployment does not have yet, and every one of them is a
# resource somebody pays for monthly whether or not a lesson is ever booked.
# What IS here is the smallest set that lets a person register, keep a score on
# the server, and pay a teacher: Cognito, RDS, S3, Lambda + API Gateway,
# Secrets Manager.
#
# State is LOCAL for now (terraform.tfstate beside this file, gitignored). Move
# it to an S3 backend with a DynamoDB lock table before a second person ever
# runs apply — two people applying against separate local states will fight
# over the same AWS resources and neither one will know.

terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # backend "s3" {
  #   bucket         = "iydani-tfstate"
  #   key            = "backend/terraform.tfstate"
  #   region         = "ap-south-1"
  #   dynamodb_table = "iydani-tflock"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = var.project
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

# The default VPC is used on purpose. RDS has to live in a VPC, and building one
# means subnets, route tables, an internet gateway and a NAT gateway — and a NAT
# gateway alone is ~$32/month, several times the entire rest of this stack at
# dev scale. The database is not publicly reachable regardless (see rds.tf's
# security group), so what a bespoke VPC would buy here is isolation from other
# things in the same account, not exposure protection.
data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

data "aws_caller_identity" "current" {}

locals {
  name_prefix = "${var.project}-${var.environment}"
}
