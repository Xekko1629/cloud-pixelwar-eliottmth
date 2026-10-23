# Règles tflint pour tous les stacks de infra/.
# Installer le plugin une fois : tflint --init
plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

plugin "google" {
  enabled = true
  version = "0.40.0"
  source  = "github.com/terraform-linters/tflint-ruleset-google"
}
