// export_test.go
// Re-exports unexported symbols so the black-box handlers_test package can
// call them directly in unit tests without touching the public API surface.
package handlers

// ComputeHandicapPairExported exposes computeHandicapPair for Tier 1 unit tests.
var ComputeHandicapPairExported = computeHandicapPair
