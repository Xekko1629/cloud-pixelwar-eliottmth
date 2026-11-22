// Package discordproxy is the Discord interactions proxy in Go (ADR-0016): it verifies the
// Ed25519 signature, answers PING, publishes /draw, /admin and /get to discord-command and defers
// the answer, within Discord's 3 seconds. Same contract as the TypeScript reference
// app/functions/discord-proxy, checked by app/testing/golden/discord-proxy.json.
package discordproxy

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"time"

	"github.com/GoogleCloudPlatform/functions-framework-go/functions"
)

const (
	healthPath       = "/discord/health"
	interactionsPath = "/discord/interactions"
	signatureWindow  = 5 * time.Minute
	maxBodyBytes     = 1 << 20 // far above any Discord interaction
)

var (
	timestampRe = regexp.MustCompile(`^\d{1,12}$`)
	signatureRe = regexp.MustCompile(`^[a-fA-F0-9]{128}$`)
	publicKeyRe = regexp.MustCompile(`^[a-fA-F0-9]{64}$`)
)

// Handler is the proxy with its injected dependencies; nil fields make it fail closed (503).
type Handler struct {
	PublicKey     ed25519.PublicKey
	ApplicationID string
	Publish       PublishCommand
	Telemetry     *Telemetry
	Now           func() time.Time
}

// NewHandler builds the proxy from its configuration; an invalid public key leaves it unavailable.
func NewHandler(publicKey, applicationID string, publish PublishCommand, telemetry *Telemetry) *Handler {
	h := &Handler{ApplicationID: applicationID, Publish: publish, Telemetry: telemetry, Now: time.Now}
	if publicKeyRe.MatchString(publicKey) {
		key, _ := hex.DecodeString(publicKey)
		h.PublicKey = ed25519.PublicKey(key)
	}
	return h
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Warm-up target of the gateway Scheduler job: no signature, publication or log.
	if r.URL.Path == healthPath {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			reply(w, http.StatusMethodNotAllowed, map[string]any{"error": "Method not allowed."})
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if h.PublicKey == nil || h.ApplicationID == "" || h.Publish == nil || h.Telemetry == nil {
		reply(w, http.StatusServiceUnavailable, map[string]any{"error": "Proxy unavailable."})
		return
	}
	if r.URL.Path != interactionsPath {
		reply(w, http.StatusNotFound, map[string]any{"error": "Not found."})
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		reply(w, http.StatusMethodNotAllowed, map[string]any{"error": "Method not allowed."})
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes+1))
	if err != nil || len(body) > maxBodyBytes || !h.validSignature(r, body) {
		h.Telemetry.log(nil, "WARNING", "Discord signature rejected.", "discord.proxy.invalid_signature")
		reply(w, http.StatusUnauthorized, map[string]any{"error": "Invalid request signature."})
		return
	}

	var decoded any
	decoder := json.NewDecoder(bytes.NewReader(body))
	if decoder.Decode(&decoded) != nil || decoder.More() {
		reply(w, http.StatusBadRequest, map[string]any{"error": "Invalid JSON."})
		return
	}
	interaction, ok := record(decoded)
	if !ok {
		reply(w, http.StatusBadRequest, map[string]any{"error": "Invalid interaction."})
		return
	}
	// Reject signed callbacks for another application, including PINGs.
	if interaction["application_id"] != h.ApplicationID {
		reply(w, http.StatusBadRequest, map[string]any{"error": "Invalid application."})
		return
	}
	if numberIs(interaction["type"], 1) {
		reply(w, http.StatusOK, map[string]any{"type": 1})
		return
	}
	data, dataOK := record(interaction["data"])
	name, nameOK := data["name"].(string)
	if !numberIs(interaction["type"], 2) || !dataOK || !numberIs(data["type"], 1) || !nameOK {
		reply(w, http.StatusBadRequest, map[string]any{"error": "Unsupported interaction."})
		return
	}
	if !forwardedCommands[name] {
		reply(w, http.StatusOK, ephemeral("Cette commande n'est pas encore disponible."))
		return
	}
	event, err := CommandEvent(interaction, h.ApplicationID)
	if err != nil {
		if input, isInput := err.(*UserInputError); isInput {
			reply(w, http.StatusOK, ephemeral(input.Answer))
			return
		}
		reply(w, http.StatusBadRequest, map[string]any{"error": "Invalid command interaction."})
		return
	}

	// Root trace only after signature/command validation; never trust public trace headers.
	err = h.Telemetry.Request(r.Context(), event.CorrelationID, func(operation *Operation) error {
		operation.Outcome("error", "publish")
		if err := h.Publish(r.Context(), event, operation.Attributes()); err != nil {
			return err
		}
		operation.Outcome("published", "none")
		operation.Log("INFO", "Discord command published.", "discord.proxy.published")
		return nil
	})
	if err != nil {
		// Never log the error: it may describe the message or the request.
		h.Telemetry.log(nil, "ERROR", "Discord command publication failed; delivery may be uncertain.", "discord.proxy.publish_failed")
		reply(w, http.StatusServiceUnavailable, map[string]any{"error": "Command publication unavailable."})
		return
	}
	// /admin answers (confirmation or refusal) are only shown to their author.
	if event.Payload.Command == "admin" {
		reply(w, http.StatusOK, map[string]any{"type": 5, "data": map[string]any{"flags": 64}})
		return
	}
	reply(w, http.StatusOK, map[string]any{"type": 5})
}

func (h *Handler) validSignature(r *http.Request, body []byte) bool {
	timestamp := r.Header.Get("X-Signature-Timestamp")
	signature := r.Header.Get("X-Signature-Ed25519")
	if !timestampRe.MatchString(timestamp) || !signatureRe.MatchString(signature) {
		return false
	}
	seconds, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil || math.Abs(float64(h.Now().UnixMilli()-seconds*1000)) > float64(signatureWindow.Milliseconds()) {
		return false
	}
	raw, _ := hex.DecodeString(signature)
	return ed25519.Verify(h.PublicKey, append([]byte(timestamp), body...), raw)
}

// Immediate answer only its author sees, without any mention.
func ephemeral(content string) map[string]any {
	return map[string]any{"type": 4, "data": map[string]any{
		"content": content, "flags": 64, "allowed_mentions": map[string]any{"parse": []string{}},
	}}
}

func reply(w http.ResponseWriter, status int, value any) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(bytes.TrimSuffix(buffer.Bytes(), []byte("\n")))
}

func init() {
	project := os.Getenv("GOOGLE_CLOUD_PROJECT")
	client := &http.Client{Transport: http.DefaultTransport}
	tokens := NewMetadataTokens(&http.Client{Timeout: 2 * time.Second})
	options := TelemetryOptions{ProjectID: project}
	if env := os.Getenv("APP_ENV"); project != "" && (env == "dev" || env == "prd") {
		options.Export = &http.Client{Transport: bearer{tokens: tokens, base: http.DefaultTransport}}
	}
	var publish PublishCommand
	if topic := os.Getenv("DISCORD_COMMAND_TOPIC"); project != "" && topic != "" {
		publisher := NewPublisher(client, tokens, project, topic)
		publish = publisher.Publish
		// Only on Cloud Run: prepares the token and the TLS connection before the first command.
		if os.Getenv("K_SERVICE") != "" {
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				publisher.Warm(ctx)
			}()
		}
	}
	handler := NewHandler(os.Getenv("DISCORD_PUBLIC_KEY"), os.Getenv("DISCORD_APPLICATION_ID"), publish, NewTelemetry(options))
	functions.HTTP("handleDiscordProxy", handler.ServeHTTP)
}
