output "source_archive" {
  description = "source_archive input of module function: bucket, object, exact generation and SHA-256"
  value = {
    bucket     = google_storage_bucket_object.source.bucket
    object     = google_storage_bucket_object.source.name
    generation = tostring(google_storage_bucket_object.source.generation)
    sha256     = data.archive_file.source.output_sha256
  }
}
