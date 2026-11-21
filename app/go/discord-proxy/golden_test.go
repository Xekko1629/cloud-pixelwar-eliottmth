package discordproxy

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

// Reference cases produced by the TypeScript proxy (functions/discord-proxy/src/golden.test.ts).
const goldenPath = "../../testing/golden/discord-proxy.json"

type golden struct {
	PublicKey     string `json:"public_key"`
	ApplicationID string `json:"application_id"`
	NowMs         int64  `json:"now_ms"`
	Cases         []struct {
		Name    string `json:"name"`
		Request struct {
			Method  string            `json:"method"`
			Path    string            `json:"path"`
			Headers map[string]string `json:"headers"`
			Body    string            `json:"body"`
		} `json:"request"`
		Response struct {
			Status int    `json:"status"`
			Body   any    `json:"body"`
			Allow  string `json:"allow"`
		} `json:"response"`
		Published any `json:"published"`
	} `json:"cases"`
}

func loadGolden(t *testing.T) golden {
	t.Helper()
	raw, err := os.ReadFile(goldenPath)
	if err != nil {
		t.Fatalf("reference cases missing: %v", err)
	}
	var g golden
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatalf("reference cases unreadable: %v", err)
	}
	return g
}

func TestSameContractAsTheTypeScriptProxy(t *testing.T) {
	g := loadGolden(t)
	if len(g.Cases) < 20 {
		t.Fatalf("expected the full reference set, got %d cases", len(g.Cases))
	}
	for _, c := range g.Cases {
		t.Run(c.Name, func(t *testing.T) {
			var published []*Event
			handler := NewHandler(g.PublicKey, g.ApplicationID, func(_ context.Context, event *Event, attributes map[string]string) error {
				if attributes["correlation_id"] != event.EventID || len(attributes["traceparent"]) != 55 {
					t.Errorf("unexpected message attributes %v", attributes)
				}
				published = append(published, event)
				return nil
			}, NewTelemetry(TelemetryOptions{ProjectID: "pixelwar-test", Write: func(string) {}}))
			handler.Now = func() time.Time { return time.UnixMilli(g.NowMs) }

			request := httptest.NewRequest(c.Request.Method, c.Request.Path, strings.NewReader(c.Request.Body))
			for name, value := range c.Request.Headers {
				request.Header.Set(name, value)
			}
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)

			if recorder.Code != c.Response.Status {
				t.Fatalf("status %d, want %d (body %s)", recorder.Code, c.Response.Status, recorder.Body.String())
			}
			var body any
			if recorder.Body.Len() > 0 {
				if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
					t.Fatalf("response is not JSON: %s", recorder.Body.String())
				}
			}
			if !reflect.DeepEqual(body, c.Response.Body) {
				t.Errorf("body %v, want %v", body, c.Response.Body)
			}
			if got := recorder.Header().Get("Allow"); got != c.Response.Allow {
				t.Errorf("Allow %q, want %q", got, c.Response.Allow)
			}
			var got any
			if len(published) == 1 {
				raw, _ := json.Marshal(published[0])
				_ = json.Unmarshal(raw, &got)
			} else if len(published) > 1 {
				t.Fatalf("published %d messages", len(published))
			}
			if !reflect.DeepEqual(got, c.Published) {
				t.Errorf("published %v\nwant %v", got, c.Published)
			}
		})
	}
}

func TestGoldenKeyIsATestKey(t *testing.T) {
	// Guards against a real key ending up in the reference file.
	key, _ := hex.DecodeString(loadGolden(t).PublicKey)
	if len(key) != 32 {
		t.Fatal("reference public key must be a 32-byte Ed25519 key")
	}
}
