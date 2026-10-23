output "runner_label" {
  description = "Label to use in runs-on to target the self-hosted runners"
  value       = github_actions_variable.runner_label.value
}
