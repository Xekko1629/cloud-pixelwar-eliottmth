package discordproxy

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type staticTokens string

func (s staticTokens) Token(context.Context) (string, error) { return string(s), nil }

func sampleEvent() *Event {
	return &Event{SchemaVersion: 1, EventID: "e", CorrelationID: "e", Source: "discord", OccurredAt: "2027-01-15T08:00:00.000Z",
		Actor: Actor{UID: "1", Name: "n", Roles: []string{}}, Payload: Payload{Command: "draw",
			Options: map[string]any{"x": int64(1), "y": int64(2), "color": int64(3)}, InteractionToken: "synthetic-interaction-token"}}
}

func TestPublishSendsOneMessageWithItsAttributes(t *testing.T) {
	var seen struct {
		path, auth string
		body       map[string][]struct {
			Data       string            `json:"data"`
			Attributes map[string]string `json:"attributes"`
		}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen.path, seen.auth = r.URL.Path, r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&seen.body)
		_, _ = w.Write([]byte(`{"messageIds":["42"]}`))
	}))
	defer server.Close()
	publisher := NewPublisher(server.Client(), staticTokens("synthetic-access-token"), "pixelwar-test", "discord-command")
	publisher.endpoint = server.URL
	attributes := map[string]string{"correlation_id": "e", "traceparent": "00-" + strings.Repeat("1", 32) + "-" + strings.Repeat("2", 16) + "-01"}
	if err := publisher.Publish(context.Background(), sampleEvent(), attributes); err != nil {
		t.Fatal(err)
	}
	if seen.path != "/v1/projects/pixelwar-test/topics/discord-command:publish" || seen.auth != "Bearer synthetic-access-token" {
		t.Fatalf("unexpected request %s %s", seen.path, seen.auth)
	}
	messages := seen.body["messages"]
	data, _ := base64.StdEncoding.DecodeString(messages[0].Data)
	var event map[string]any
	if len(messages) != 1 || json.Unmarshal(data, &event) != nil || event["event_id"] != "e" || messages[0].Attributes["traceparent"] != attributes["traceparent"] {
		t.Fatalf("unexpected message %v", seen.body)
	}
}

func TestPublishRefusalIsAnErrorWithoutTheMessage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"synthetic-interaction-token"}`))
	}))
	defer server.Close()
	publisher := NewPublisher(server.Client(), staticTokens("t"), "p", "t")
	publisher.endpoint = server.URL
	err := publisher.Publish(context.Background(), sampleEvent(), map[string]string{})
	if err == nil || strings.Contains(err.Error(), "synthetic-interaction-token") {
		t.Fatalf("expected a safe error, got %v", err)
	}
}

func TestPublishIsBoundedToOneSecond(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(3 * time.Second):
		}
	}))
	defer server.Close()
	publisher := NewPublisher(server.Client(), staticTokens("t"), "p", "t")
	publisher.endpoint = server.URL
	started := time.Now()
	if err := publisher.Publish(context.Background(), sampleEvent(), map[string]string{}); err == nil || time.Since(started) > 2*time.Second {
		t.Fatalf("expected a timeout within the bound, got %v after %s", err, time.Since(started))
	}
}

func TestMetadataTokenIsCachedUntilShortlyBeforeExpiry(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Metadata-Flavor") != "Google" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		_, _ = w.Write([]byte(`{"access_token":"synthetic-access-token","expires_in":3599,"token_type":"Bearer"}`))
	}))
	defer server.Close()
	now := time.Unix(0, 0)
	tokens := &metadataTokens{client: server.Client(), url: server.URL, now: func() time.Time { return now }}
	for i := 0; i < 3; i++ {
		if token, err := tokens.Token(context.Background()); err != nil || token != "synthetic-access-token" {
			t.Fatalf("token %q, err %v", token, err)
		}
	}
	now = now.Add(59 * time.Minute)
	_, _ = tokens.Token(context.Background())
	if calls.Load() != 2 {
		t.Fatalf("expected one refresh after 59 minutes, got %d calls", calls.Load())
	}
}

func TestWarmPreparesTokenAndConnection(t *testing.T) {
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()
	var tokenCalls atomic.Int32
	publisher := NewPublisher(server.Client(), countingTokens{&tokenCalls}, "p", "t")
	publisher.endpoint = server.URL
	publisher.Warm(context.Background())
	if tokenCalls.Load() != 1 || hits.Load() != 1 {
		t.Fatalf("warm-up must fetch the token and reach Pub/Sub once, got %d and %d", tokenCalls.Load(), hits.Load())
	}
}

type countingTokens struct{ calls *atomic.Int32 }

func (c countingTokens) Token(context.Context) (string, error) {
	c.calls.Add(1)
	return "t", nil
}
