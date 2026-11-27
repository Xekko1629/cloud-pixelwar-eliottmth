variable "project_id" {
  description = "Project that owns the subscription, its DLQ and the worker"
  type        = string
}

variable "name" {
  description = "Subscription name: the consumer, suffixed with the topic when it listens to several (docs/events.md, 7.1)"
  type        = string

  validation {
    # "-dlq-inspect" (12 characters) must still fit the 255-character limit.
    condition     = can(regex("^[a-z][a-z0-9-]{2,242}$", var.name)) && !startswith(var.name, "goog")
    error_message = "name must be 3 to 243 lowercase letters, digits or hyphens, start with a letter and not start with goog."
  }
}

variable "topic_id" {
  description = "Full id of the source topic: projects/<project>/topics/<name>"
  type        = string
}

variable "push_endpoint" {
  description = "Private run.app URI of the worker, also used as OIDC audience"
  type        = string

  validation {
    condition     = startswith(var.push_endpoint, "https://")
    error_message = "push_endpoint must be an https URI."
  }
}

variable "invoker_service_account_email" {
  description = "Dedicated push identity of the worker (modules/function output), never its runtime identity"
  type        = string
}

variable "pubsub_agent_member" {
  description = "serviceAccount:<email> of the managed Pub/Sub service agent, which forwards to the DLQ"
  type        = string
}

variable "ack_deadline_seconds" {
  description = "Acknowledgement deadline; must exceed the worker timeout (600 s maximum for push)"
  type        = number

  validation {
    condition     = var.ack_deadline_seconds >= 10 && var.ack_deadline_seconds <= 600
    error_message = "ack_deadline_seconds must be between 10 and 600."
  }
}

variable "max_delivery_attempts" {
  description = "Approximate delivery attempts before the DLQ (Pub/Sub allows 5 to 100)"
  type        = number
  default     = 5

  validation {
    condition     = var.max_delivery_attempts >= 5 && var.max_delivery_attempts <= 100 && floor(var.max_delivery_attempts) == var.max_delivery_attempts
    error_message = "max_delivery_attempts must be an integer between 5 and 100."
  }
}

variable "labels" {
  description = "Labels of the subscriptions and the DLQ topic"
  type        = map(string)
  default     = {}
}
