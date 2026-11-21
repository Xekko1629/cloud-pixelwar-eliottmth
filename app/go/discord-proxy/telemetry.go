package discordproxy

// OpenTelemetry for the Go proxy (ADR-0016, SRV-08): the same server span, attributes,
// metrics and log fields as app/shared/src/observability, exported in OTLP to
// telemetry.googleapis.com and flushed before the response, like the TypeScript version.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

const (
	serviceName   = "discord-proxy"
	spanName      = "discord.interactions.draw"
	exportTimeout = 500 * time.Millisecond // exportTimeoutMillis of createFunctionTelemetry
)

// Telemetry is one SDK per instance. A telemetry failure never fails or replays the request.
type Telemetry struct {
	projectID string
	write     func(line string)
	tracer    trace.Tracer
	traces    *sdktrace.TracerProvider
	metrics   *sdkmetric.MeterProvider
	attempts  metric.Int64Counter
	duration  metric.Float64Histogram
}

// Operation is the request being observed: outcome, safe logs and message attributes.
type Operation struct {
	ctx       context.Context
	telemetry *Telemetry
	outcome   string
	reason    string
}

type TelemetryOptions struct {
	ProjectID string
	Write     func(line string)
	// Export is nil in tests and outside dev/prd: spans exist, nothing leaves the process.
	Export *http.Client
}

// bearer adds the runtime access token to the OTLP requests.
type bearer struct {
	tokens TokenSource
	base   http.RoundTripper
}

func (b bearer) RoundTrip(request *http.Request) (*http.Response, error) {
	token, err := b.tokens.Token(request.Context())
	if err != nil {
		return nil, err
	}
	clone := request.Clone(request.Context())
	clone.Header.Set("Authorization", "Bearer "+token)
	return b.base.RoundTrip(clone)
}

func NewTelemetry(options TelemetryOptions) *Telemetry {
	write := options.Write
	if write == nil {
		write = func(line string) { _, _ = io.WriteString(os.Stdout, line) }
	}
	environment := "dev"
	if os.Getenv("APP_ENV") == "prd" {
		environment = "prd"
	}
	version := os.Getenv("K_REVISION")
	if version == "" {
		version = "development"
	}
	region := os.Getenv("FUNCTION_REGION")
	if region == "" {
		region = "unknown"
	}
	res := resource.NewSchemaless(
		attribute.String("service.name", serviceName),
		attribute.String("service.version", version),
		attribute.String("service.instance.id", randomHex(16)),
		attribute.String("deployment.environment.name", environment),
		attribute.String("gcp.project_id", options.ProjectID),
		attribute.String("cloud.provider", "gcp"),
		attribute.String("cloud.region", region),
	)
	traceOptions := []sdktrace.TracerProviderOption{sdktrace.WithResource(res),
		sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.AlwaysSample()))}
	metricOptions := []sdkmetric.Option{sdkmetric.WithResource(res)}
	if options.Export != nil {
		traceExporter, err := otlptracehttp.New(context.Background(),
			otlptracehttp.WithEndpointURL("https://telemetry.googleapis.com/v1/traces"),
			otlptracehttp.WithHTTPClient(options.Export), otlptracehttp.WithTimeout(exportTimeout))
		if err == nil {
			traceOptions = append(traceOptions, sdktrace.WithBatcher(traceExporter, sdktrace.WithExportTimeout(exportTimeout)))
		}
		metricExporter, err := otlpmetrichttp.New(context.Background(),
			otlpmetrichttp.WithEndpointURL("https://telemetry.googleapis.com/v1/metrics"),
			otlpmetrichttp.WithHTTPClient(options.Export), otlpmetrichttp.WithTimeout(exportTimeout))
		if err == nil {
			metricOptions = append(metricOptions, sdkmetric.WithReader(sdkmetric.NewPeriodicReader(metricExporter,
				sdkmetric.WithInterval(time.Minute), sdkmetric.WithTimeout(exportTimeout+time.Second))))
		}
	}
	t := &Telemetry{projectID: options.ProjectID, write: write,
		traces: sdktrace.NewTracerProvider(traceOptions...), metrics: sdkmetric.NewMeterProvider(metricOptions...)}
	t.tracer = t.traces.Tracer("pixelwar")
	meter := t.metrics.Meter("pixelwar")
	t.attempts, _ = meter.Int64Counter("pixelwar.function.attempts", metric.WithUnit("{attempt}"),
		metric.WithDescription("Validated processing attempts, including redeliveries"))
	t.duration, _ = meter.Float64Histogram("pixelwar.function.duration", metric.WithUnit("s"),
		metric.WithDescription("Validated operation duration before telemetry flush"))
	return t
}

// Request runs work in the root server span of a public request, then flushes before returning.
func (t *Telemetry) Request(ctx context.Context, correlationID string, work func(*Operation) error) error {
	started := time.Now()
	ctx, span := t.tracer.Start(ctx, spanName, trace.WithSpanKind(trace.SpanKindServer),
		trace.WithAttributes(attribute.String("correlation_id", correlationID)))
	ctx = context.WithValue(ctx, correlationKey{}, correlationID)
	operation := &Operation{ctx: ctx, telemetry: t, outcome: "error", reason: "none"}
	err := work(operation)
	if err != nil {
		// Error messages may contain tokens or payloads: only a safe marker.
		operation.outcome = "error"
		span.SetStatus(codes.Error, "Operation failed")
		span.AddEvent("operation.failed")
		operation.Log("ERROR", "Operation failed", "")
	}
	span.End()
	labels := metric.WithAttributes(attribute.String("source", "discord"),
		attribute.String("outcome", operation.outcome), attribute.String("reason", operation.reason))
	t.attempts.Add(context.Background(), 1, labels)
	t.duration.Record(context.Background(), time.Since(started).Seconds(), labels)
	t.flush()
	return err
}

func (t *Telemetry) flush() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*exportTimeout)
	defer cancel()
	var wg sync.WaitGroup
	var failed bool
	var mu sync.Mutex
	for _, flush := range []func(context.Context) error{t.traces.ForceFlush, t.metrics.ForceFlush} {
		wg.Add(1)
		go func(flush func(context.Context) error) {
			defer wg.Done()
			if flush(ctx) != nil {
				mu.Lock()
				failed = true
				mu.Unlock()
			}
		}(flush)
	}
	wg.Wait()
	if failed {
		t.write(fmt.Sprintf("{\"severity\":\"WARNING\",\"function\":%q,\"event_type\":\"telemetry.export_failed\"}\n", serviceName))
	}
}

type correlationKey struct{}

// Attributes carries the trace context and correlation ID to the published message.
func (o *Operation) Attributes() map[string]string {
	carrier := propagation.MapCarrier{}
	propagation.TraceContext{}.Inject(o.ctx, carrier)
	return map[string]string{"correlation_id": o.ctx.Value(correlationKey{}).(string), "traceparent": carrier["traceparent"]}
}

func (o *Operation) Outcome(value, reason string) { o.outcome, o.reason = value, reason }

// Log writes the shared structured log record, with the active trace fields.
func (o *Operation) Log(severity, message, eventType string) {
	o.telemetry.log(o.ctx, severity, message, eventType)
}

func (t *Telemetry) log(ctx context.Context, severity, message, eventType string) {
	record := map[string]any{
		"timestamp": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), "severity": severity,
		"message": message, "function": serviceName, "event_type": nil, "correlation_id": nil, "user_id": nil,
	}
	if eventType != "" {
		record["event_type"] = eventType
	}
	if ctx != nil {
		if id, ok := ctx.Value(correlationKey{}).(string); ok {
			record["correlation_id"] = id
		}
		if span := trace.SpanContextFromContext(ctx); span.IsValid() {
			record["logging.googleapis.com/trace"] = fmt.Sprintf("projects/%s/traces/%s", t.projectID, span.TraceID())
			record["logging.googleapis.com/spanId"] = span.SpanID().String()
			record["logging.googleapis.com/trace_sampled"] = span.IsSampled()
		}
	}
	line, err := json.Marshal(record)
	if err == nil {
		t.write(string(line) + "\n")
	}
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
