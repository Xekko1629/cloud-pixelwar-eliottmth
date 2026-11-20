output "project_editors" {
  description = "Principals granted roles/editor on the project by this stack"
  value       = sort(tolist(local.editors))
}
