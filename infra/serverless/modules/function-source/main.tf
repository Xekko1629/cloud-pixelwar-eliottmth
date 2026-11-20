# Zips the built function and uploads it for Cloud Build (ADR-0009). The archive is
# deterministic (same files, same SHA-256), so an unchanged function is not re-uploaded
# nor redeployed. The object name carries the SHA-256: a code change is a new object.
data "archive_file" "source" {
  type             = "zip"
  source_dir       = var.source_dir
  output_path      = "${path.root}/.build/${var.name}.zip"
  output_file_mode = "0644"
}

resource "google_storage_bucket_object" "source" {
  bucket       = var.bucket
  name         = "functions/${var.name}/${data.archive_file.source.output_sha256}.zip"
  source       = data.archive_file.source.output_path
  content_type = "application/zip"
}
