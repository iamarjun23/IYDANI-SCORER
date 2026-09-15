# Where the music actually lives.
#
# docs/roadmap/DATABASE-SCHEMA.md's rule, kept: a score is an S3 object and the
# database holds only its key. A .dng.json with a few hundred notes plus its
# history is not something a Postgres column stores well, and every autosave
# would rewrite that row — so the DB tracks WHICH score, S3 holds WHAT it is.
#
# Nothing in this bucket is public. The renderer reads and writes objects
# through presigned URLs the API hands out per request, which is also why the
# API never proxies a score body: a presigned PUT goes from the app straight to
# S3, so a 2 MB score does not pass through a Lambda that bills by the
# millisecond and caps request bodies at 6 MB.

resource "aws_s3_bucket" "scores" {
  bucket = "${local.name_prefix}-scores-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "scores" {
  bucket = aws_s3_bucket.scores.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "scores" {
  bucket = aws_s3_bucket.scores.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Snapshots are immutable by design — a new save writes a NEW key, it never
# overwrites an existing one, so versioning is belt-and-braces against a bug
# that writes to the wrong key rather than the primary history mechanism.
resource "aws_s3_bucket_versioning" "scores" {
  bucket = aws_s3_bucket.scores.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Every autosave is a new object, so without this the bucket grows without
# bound for a score somebody edits all afternoon. The CURRENT score is always
# reachable through Project.scoreS3Key; what expires here is old snapshots.
resource "aws_s3_bucket_lifecycle_configuration" "scores" {
  bucket = aws_s3_bucket.scores.id

  rule {
    id     = "expire-old-snapshots"
    status = "Enabled"

    filter {
      prefix = "snapshots/"
    }

    expiration {
      days = 90
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# CORS is required even though the URLs are presigned. The renderer is a page
# loaded from file://, so a fetch() to S3 is cross-origin and a PUT carrying a
# Content-Type header triggers a preflight; without a matching rule the browser
# refuses the upload before S3 ever sees it. A file:// page sends `Origin: null`,
# which no explicit origin string matches — hence "*". That is not an access
# grant: the bucket is private, and the only way in is a signed URL that expires.
resource "aws_s3_bucket_cors_configuration" "scores" {
  bucket = aws_s3_bucket.scores.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT", "HEAD"]
    allowed_origins = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}
