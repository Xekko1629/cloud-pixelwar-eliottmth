package discordproxy

// discord-command v1 envelope (docs/events.md, section 3.1), identical to the TypeScript
// reference app/functions/discord-proxy/src/event.ts (ADR-0016). Every rule below mirrors
// a check of that file; app/testing/golden/discord-proxy.json keeps both in step.

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"math/big"
	"regexp"
	"sort"
	"time"
	"unicode/utf16"
)

const (
	coordinateLimit = 1_000_000_000 // COORDINATE_LIMIT, app/shared/src/grid/constants.ts
	paletteLength   = 16            // PALETTE.length
	maxActorName    = 32            // command-worker accepts 1 to 32 code points
	maxSafeInteger  = 1<<53 - 1     // Number.MAX_SAFE_INTEGER
	discordEpochMs  = 1_420_070_400_000
)

// Commands this proxy forwards; the others get an immediate ephemeral answer.
var forwardedCommands = map[string]bool{"draw": true, "admin": true}

// Discord sends a subcommand as one option of type 1 holding its own options: name → type.
var adminOptions = map[string]map[string]float64{
	"pause": {}, "resume": {}, "clear": {},
	"ratelimit": {"user": 6, "limit": 4},
	"size":      {"width": 4, "height": 4},
}

var (
	snowflakeRe  = regexp.MustCompile(`^[1-9][0-9]{0,19}$`)
	maxSnowflake = new(big.Int).SetUint64(math.MaxUint64)
	errInvalid   = errors.New("invalid interaction")
)

// UserInputError is an interaction the user can fix: answered at once, never published.
type UserInputError struct{ Answer string }

func (e *UserInputError) Error() string { return "invalid user input" }

type Actor struct {
	UID   string   `json:"uid"`
	Name  string   `json:"name"`
	Roles []string `json:"roles"`
}

type Payload struct {
	Command          string         `json:"command"`
	Options          map[string]any `json:"options"`
	InteractionID    string         `json:"interaction_id"`
	ApplicationID    string         `json:"application_id"`
	GuildID          string         `json:"guild_id"`
	ChannelID        string         `json:"channel_id"`
	InteractionToken string         `json:"interaction_token"`
}

type Event struct {
	SchemaVersion int     `json:"schema_version"`
	EventID       string  `json:"event_id"`
	CorrelationID string  `json:"correlation_id"`
	Source        string  `json:"source"`
	OccurredAt    string  `json:"occurred_at"`
	Actor         Actor   `json:"actor"`
	Payload       Payload `json:"payload"`
}

func snowflake(value any) (string, bool) {
	s, ok := value.(string)
	if !ok || !snowflakeRe.MatchString(s) {
		return "", false
	}
	n, _ := new(big.Int).SetString(s, 10)
	return s, n.Cmp(maxSnowflake) <= 0
}

// JavaScript string length, in UTF-16 code units.
func jsLength(s string) int { return len(utf16.Encode([]rune(s))) }

// Number.isSafeInteger on a decoded JSON number: 3 and 3.0 are both accepted.
func safeInteger(value any) (int64, bool) {
	f, ok := value.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) || f != math.Trunc(f) || math.Abs(f) > maxSafeInteger {
		return 0, false
	}
	return int64(f), true
}

// Strict JavaScript equality with a number literal (1 === 1.0).
func numberIs(value any, expected float64) bool {
	f, ok := value.(float64)
	return ok && f == expected
}

func record(value any) (map[string]any, bool) {
	m, ok := value.(map[string]any)
	return m, ok && m != nil
}

func drawOptions(options any) (map[string]any, error) {
	list, ok := options.([]any)
	if !ok || len(list) != 3 {
		return nil, errInvalid
	}
	values := map[string]int64{}
	for _, item := range list {
		option, ok := record(item)
		if !ok {
			return nil, errInvalid
		}
		name, isString := option["name"].(string)
		if !isString || (name != "x" && name != "y" && name != "color") || !numberIs(option["type"], 4) {
			return nil, errInvalid
		}
		value, safe := safeInteger(option["value"])
		if _, duplicate := values[name]; !safe || duplicate {
			return nil, errInvalid
		}
		values[name] = value
	}
	x, y, color := values["x"], values["y"], values["color"]
	if abs(x) > coordinateLimit || abs(y) > coordinateLimit || color < 1 || color > paletteLength {
		return nil, errInvalid
	}
	return map[string]any{"x": x, "y": y, "color": color}, nil
}

func adminOptionsOf(options any) (map[string]any, error) {
	list, ok := options.([]any)
	if !ok || len(list) != 1 {
		return nil, errInvalid
	}
	sub, ok := record(list[0])
	if !ok || !numberIs(sub["type"], 1) {
		return nil, errInvalid
	}
	subcommand, isString := sub["name"].(string)
	allowed, known := adminOptions[subcommand]
	if !isString || !known {
		return nil, errInvalid
	}
	nested := []any{}
	if raw, present := sub["options"]; present && raw != nil {
		if nested, ok = raw.([]any); !ok {
			return nil, errInvalid
		}
	}
	if len(nested) > len(allowed) {
		return nil, errInvalid
	}
	values := map[string]any{"subcommand": subcommand}
	for _, item := range nested {
		option, ok := record(item)
		if !ok {
			return nil, errInvalid
		}
		name, isString := option["name"].(string)
		expected, known := allowed[name]
		if _, duplicate := values[name]; !isString || !known || !numberIs(option["type"], expected) || duplicate {
			return nil, errInvalid
		}
		if expected == 6 {
			user, valid := snowflake(option["value"])
			if !valid {
				return nil, errInvalid
			}
			values[name] = user
		} else {
			value, safe := safeInteger(option["value"])
			if !safe {
				return nil, errInvalid
			}
			values[name] = value
		}
	}
	if subcommand == "ratelimit" && len(nested) != 2 {
		return nil, errInvalid
	}
	// Discord cannot require "both or neither": answer the user rather than fail in a worker.
	if subcommand == "size" && len(nested) == 1 {
		return nil, &UserInputError{Answer: "Indique `width` et `height` ensemble, ou aucun des deux pour une grille infinie."}
	}
	return values, nil
}

// CommandEvent validates a signed application command and builds its discord-command event.
func CommandEvent(interaction map[string]any, applicationID string) (*Event, error) {
	data, dataOK := record(interaction["data"])
	member, memberOK := record(interaction["member"])
	var user map[string]any
	if memberOK {
		user, memberOK = record(member["user"])
	}
	id, idOK := snowflake(interaction["id"])
	guild, guildOK := snowflake(interaction["guild_id"])
	channel, channelOK := snowflake(interaction["channel_id"])
	token, tokenOK := interaction["token"].(string)
	if !idOK || interaction["application_id"] != applicationID || !guildOK || !channelOK ||
		!tokenOK || jsLength(token) < 1 || jsLength(token) > 4096 ||
		!dataOK || !forwardedCommands[stringOf(data["name"])] || !numberIs(data["type"], 1) || !memberOK {
		return nil, errInvalid
	}
	uid, uidOK := snowflake(user["id"])
	username, nameOK := user["username"].(string)
	rawRoles, rolesOK := member["roles"].([]any)
	if !uidOK || !nameOK || jsLength(username) < 1 || jsLength(username) > 80 || !rolesOK {
		return nil, errInvalid
	}
	unique := map[string]bool{}
	for _, role := range rawRoles {
		value, valid := snowflake(role)
		if !valid {
			return nil, errInvalid
		}
		unique[value] = true
	}
	roles := make([]string, 0, len(unique))
	for role := range unique {
		roles = append(roles, role)
	}
	sort.Strings(roles)

	command := stringOf(data["name"])
	var options map[string]any
	var err error
	if command == "admin" {
		options, err = adminOptionsOf(data["options"])
	} else {
		options, err = drawOptions(data["options"])
	}
	if err != nil {
		return nil, err
	}

	eventID := deriveEventID(applicationID, id)
	idValue, _ := new(big.Int).SetString(id, 10)
	created := new(big.Int).Rsh(idValue, 22).Int64() + discordEpochMs
	name := []rune(username)
	if len(name) > maxActorName {
		name = name[:maxActorName]
	}
	return &Event{
		SchemaVersion: 1, EventID: eventID, CorrelationID: eventID, Source: "discord",
		OccurredAt: time.UnixMilli(created).UTC().Format("2006-01-02T15:04:05.000Z"),
		Actor:      Actor{UID: uid, Name: string(name), Roles: roles},
		Payload: Payload{
			Command: command, Options: options, InteractionID: id, ApplicationID: applicationID,
			GuildID: guild, ChannelID: channel, InteractionToken: token,
		},
	}, nil
}

// UUID-shaped, namespaced SHA-256 (UUIDv8). Stable across delivery attempts.
func deriveEventID(applicationID, interactionID string) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("pixelwar:discord-command:v1:%s:%s", applicationID, interactionID)))
	b := sum[:16]
	b[6] = (b[6] & 0x0f) | 0x80
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

func stringOf(value any) string {
	s, _ := value.(string)
	return s
}

func abs(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}
