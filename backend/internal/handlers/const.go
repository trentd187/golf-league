// handlers/const.go
// Package-wide string constants shared across all HTTP handlers.
// Centralising these eliminates the duplicate-literal SonarQube findings (S1192)
// that would otherwise appear in every write*Error helper and inline handler response.
package handlers

const (
	// jsonKeyError is the JSON response key used in every error body.
	jsonKeyError = "error"
	// msgUnauthorized is the message returned when a caller cannot be authenticated.
	msgUnauthorized = "unauthorized"
)
