package discordproxy

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"
)

// signedDraw replays the reference "draw" case with a given publisher and log sink.
func signedDraw(t *testing.T, publish PublishCommand, logs *[]string) (*Handler, *http.Request) {
	t.Helper()
	g := loadGolden(t)
	var draw *http.Request
	for _, c := range g.Cases {
		if c.Name == "draw" {
			draw = httptest.NewRequest(http.MethodPost, c.Request.Path, strings.NewReader(c.Request.Body))
			for name, value := range c.Request.Headers {
				draw.Header.Set(name, value)
			}
		}
	}
	telemetry := NewTelemetry(TelemetryOptions{ProjectID: "pixelwar-test", Write: func(line string) { *logs = append(*logs, line) }})
	handler := NewHandler(g.PublicKey, g.ApplicationID, publish, telemetry)
	handler.Now = func() time.Time { return time.UnixMilli(g.NowMs) }
	return handler, draw
}

func TestPublishesWithTraceContextThenDefers(t *testing.T) {
	var logs []string
	var attributes map[string]string
	handler, request := signedDraw(t, func(_ context.Context, _ *Event, a map[string]string) error {
		attributes = a
		return nil
	}, &logs)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || recorder.Body.String() != `{"type":5}` {
		t.Fatalf("got %d %s", recorder.Code, recorder.Body.String())
	}
	if !regexp.MustCompile(`^00-[0-9a-f]{32}-[0-9a-f]{16}-01$`).MatchString(attributes["traceparent"]) {
		t.Fatalf("traceparent must start a sampled trace, got %q", attributes["traceparent"])
	}
	var published map[string]any
	if len(logs) != 1 || json.Unmarshal([]byte(logs[0]), &published) != nil {
		t.Fatalf("expected one log line, got %v", logs)
	}
	traceID := strings.Split(attributes["traceparent"], "-")[1]
	if published["event_type"] != "discord.proxy.published" || published["correlation_id"] != attributes["correlation_id"] ||
		published["logging.googleapis.com/trace"] != "projects/pixelwar-test/traces/"+traceID || published["function"] != "discord-proxy" {
		t.Fatalf("log not correlated with the published trace: %v", published)
	}
}

func TestPublicationFailureIsNeverASuccessAndLeaksNothing(t *testing.T) {
	var logs []string
	handler, request := signedDraw(t, func(context.Context, *Event, map[string]string) error {
		return errors.New("synthetic-interaction-token in a transport error")
	}, &logs)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable || recorder.Body.String() != `{"error":"Command publication unavailable."}` {
		t.Fatalf("got %d %s", recorder.Code, recorder.Body.String())
	}
	joined := strings.Join(logs, "")
	if strings.Contains(joined, "synthetic-interaction-token") || !strings.Contains(joined, "discord.proxy.publish_failed") {
		t.Fatalf("unsafe or missing failure log: %s", joined)
	}
}

func TestFailsClosedWithoutConfigurationButStillAnswersHealth(t *testing.T) {
	handler := NewHandler("not-a-key", "123456789012345678", nil, nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, interactionsPath, strings.NewReader("{}")))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", recorder.Code)
	}
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, healthPath, nil))
	if recorder.Code != http.StatusNoContent || recorder.Body.Len() != 0 {
		t.Fatalf("health must answer 204 without configuration, got %d", recorder.Code)
	}
}

func TestRejectedSignatureIsLoggedWithoutPayload(t *testing.T) {
	var logs []string
	handler, request := signedDraw(t, func(context.Context, *Event, map[string]string) error { return nil }, &logs)
	request.Header.Set("X-Signature-Ed25519", strings.Repeat("0", 128))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized || len(logs) != 1 || strings.Contains(logs[0], "synthetic-interaction-token") ||
		!strings.Contains(logs[0], `"event_type":"discord.proxy.invalid_signature"`) || !strings.Contains(logs[0], `"correlation_id":null`) {
		t.Fatalf("got %d, logs %v", recorder.Code, logs)
	}
}

func TestBodyAboveTheLimitIsRefused(t *testing.T) {
	var logs []string
	handler, _ := signedDraw(t, func(context.Context, *Event, map[string]string) error { return nil }, &logs)
	request := httptest.NewRequest(http.MethodPost, interactionsPath, strings.NewReader(strings.Repeat(" ", maxBodyBytes+1)))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", recorder.Code)
	}
}

func TestTelemetryFailureMarksTheSpanWithoutLeakingTheError(t *testing.T) {
	var logs []string
	telemetry := NewTelemetry(TelemetryOptions{ProjectID: "pixelwar-test", Write: func(line string) { logs = append(logs, line) }})
	err := telemetry.Request(context.Background(), "abc", func(*Operation) error { return errors.New("secret detail") })
	if err == nil || len(logs) != 1 || strings.Contains(logs[0], "secret detail") || !strings.Contains(logs[0], `"message":"Operation failed"`) {
		t.Fatalf("err %v, logs %v", err, logs)
	}
}
