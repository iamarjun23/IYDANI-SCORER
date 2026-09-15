variable "project" {
  description = "Name prefix for every resource in this stack."
  type        = string
  default     = "iydani"
}

variable "environment" {
  description = "Deployment environment. Kept in every resource name so a dev and a prod stack can coexist in one account."
  type        = string
  default     = "dev"
}

variable "region" {
  description = "AWS region. ap-south-1 (Mumbai) is the default because the payment side is Razorpay/INR and the users are India-facing — put the data next to the people using it."
  type        = string
  default     = "ap-south-1"
}

variable "db_instance_class" {
  description = "RDS instance size. db.t4g.micro is inside the 12-month Free Tier on a new account; anything larger is billed from hour one."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "RDS storage in GB. 20 is the Free Tier ceiling."
  type        = number
  default     = 20
}

variable "db_username" {
  description = "Master username for the Postgres instance."
  type        = string
  default     = "iydani_admin"
}

variable "lambda_zip_path" {
  description = "Build artifact for the API Lambda — produced by `npm run build && npm run package` in backend/."
  type        = string
  default     = "../../backend/dist/api.zip"
}

variable "post_confirmation_zip_path" {
  description = "Build artifact for the Cognito post-confirmation trigger."
  type        = string
  default     = "../../backend/dist/post-confirmation.zip"
}

variable "db_allowed_cidrs" {
  description = <<-EOT
    Who may open a TCP connection to Postgres. Defaults open because the API
    Lambda runs outside the VPC (see the comment at the top of rds.tf) and so
    has no fixed egress address. NARROW THIS as soon as the addresses that need
    it are known — it is the only network control on a public database.
  EOT
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "platform_fee_percent" {
  description = "IYDANI's cut of a booking, as a whole percent. The teacher receives the rest through Razorpay Route."
  type        = number
  default     = 15
}

variable "use_secrets_manager" {
  description = <<-EOT
    DEV-COST SWITCH. Secrets Manager is the only service in this stack with NO
    AWS Free Tier — it bills ~$0.40/secret/month from the first second,
    regardless of account age. Everything else here (RDS, Lambda, API Gateway,
    S3, Cognito) is $0 on a new account for the first 12 months.

    false (the default): the DB password is passed to the Lambda as a plain
    environment variable instead of a Secrets Manager secret. Genuinely $0
    while testing. The password IS visible to anyone with read access to the
    Lambda console/API in this mode — acceptable for a database holding test
    accounts and test bookings, NOT acceptable once real people's data is in
    it.

    true: the password goes into Secrets Manager instead (secrets.tf), and the
    Lambda reads it at runtime rather than holding it in its own config. Flip
    this — and re-apply — BEFORE this deployment is shown to real users or
    handles a real payment. It costs about $1.50/month for the two secrets
    this stack uses (DB, Razorpay).
  EOT
  type    = bool
  default = false
}
