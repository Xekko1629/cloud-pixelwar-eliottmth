output "runner_labels" {
  description = "runs-on label of each runner class (small, medium)"
  value       = { for class, variable in github_actions_variable.runner_label : class => variable.value }
}
