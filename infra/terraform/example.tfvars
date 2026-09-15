# Copy to dev.tfvars and adjust, then: terraform apply -var-file=dev.tfvars
# tfvars files are gitignored — nothing secret belongs in one regardless.

region      = "ap-south-1"
environment = "dev"

# Narrow this the moment you know the addresses that need it. See rds.tf.
# db_allowed_cidrs = ["203.0.113.4/32"]
