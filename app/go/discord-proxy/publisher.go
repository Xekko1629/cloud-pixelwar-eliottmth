package discordproxy

// Pub/Sub publication through the REST API (ADR-0016): one HTTPS request, no gRPC client.
// The access token of the runtime identity comes from the metadata server. Warm() fetches
// it and opens the TLS connection at startup, so the first command only pays the publish.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

const (
	metadataTokenURL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
	pubsubEndpoint   = "https://pubsub.googleapis.com"
	publishTimeout   = time.Second // same bound as the TypeScript publisher, no retry
)

// PublishCommand publishes one discord-command event with its trace attributes.
type PublishCommand func(ctx context.Context, event *Event, attributes map[string]string) error

// TokenSource returns a valid OAuth2 access token of the runtime identity.
type TokenSource interface {
	Token(ctx context.Context) (string, error)
}

type metadataTokens struct {
	client  *http.Client
	url     string
	now     func() time.Time
	mu      sync.Mutex
	token   string
	expires time.Time
}

// NewMetadataTokens caches the token until one minute before its expiry.
func NewMetadataTokens(client *http.Client) TokenSource {
	return &metadataTokens{client: client, url: metadataTokenURL, now: time.Now}
}

func (m *metadataTokens) Token(ctx context.Context) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.token != "" && m.now().Before(m.expires) {
		return m.token, nil
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, m.url, nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("Metadata-Flavor", "Google")
	response, err := m.client.Do(request)
	if err != nil {
		return "", errors.New("metadata token unavailable")
	}
	defer response.Body.Close()
	var body struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&body) != nil || body.AccessToken == "" {
		return "", errors.New("metadata token unavailable")
	}
	m.token = body.AccessToken
	m.expires = m.now().Add(time.Duration(body.ExpiresIn)*time.Second - time.Minute)
	return m.token, nil
}

// Publisher sends discord-command events to one topic.
type Publisher struct {
	client   *http.Client
	tokens   TokenSource
	endpoint string
	topic    string
}

func NewPublisher(client *http.Client, tokens TokenSource, projectID, topic string) *Publisher {
	return &Publisher{client: client, tokens: tokens, endpoint: pubsubEndpoint,
		topic: fmt.Sprintf("projects/%s/topics/%s", projectID, topic)}
}

// Publish confirms the message before returning. Errors never carry the event or the token.
func (p *Publisher) Publish(ctx context.Context, event *Event, attributes map[string]string) error {
	ctx, cancel := context.WithTimeout(ctx, publishTimeout)
	defer cancel()
	token, err := p.tokens.Token(ctx)
	if err != nil {
		return errors.New("publication unavailable")
	}
	data, err := json.Marshal(event)
	if err != nil {
		return errors.New("publication unavailable")
	}
	body, _ := json.Marshal(map[string]any{"messages": []map[string]any{{
		"data": base64.StdEncoding.EncodeToString(data), "attributes": attributes,
	}}})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, p.endpoint+"/v1/"+p.topic+":publish", bytes.NewReader(body))
	if err != nil {
		return errors.New("publication unavailable")
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	response, err := p.client.Do(request)
	if err != nil {
		return errors.New("publication unavailable")
	}
	defer response.Body.Close()
	var result struct {
		MessageIDs []string `json:"messageIds"`
	}
	// The body is only read for the message ID; it is never logged.
	if response.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&result) != nil || len(result.MessageIDs) != 1 {
		return fmt.Errorf("publication refused (HTTP %d)", response.StatusCode)
	}
	return nil
}

// Warm fetches the token and opens the TLS connection to Pub/Sub, in the background at
// startup. Failures are ignored: the first command then pays them itself.
func (p *Publisher) Warm(ctx context.Context) {
	if _, err := p.tokens.Token(ctx); err != nil {
		return
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, p.endpoint+"/", nil)
	if err != nil {
		return
	}
	if response, err := p.client.Do(request); err == nil {
		// Drain so the connection goes back to the pool and stays open.
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
		response.Body.Close()
	}
}
