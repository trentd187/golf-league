// course_errors_test.go
// Pure unit tests for the CourseService error types' Error()/Unwrap() methods.
// These are plain value types, so the tests need no database — Tier 1, no container.
package services_test

import (
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"

	"github.com/trentd187/golf-league/internal/services"
)

func TestValidationError_Error(t *testing.T) {
	e := &services.ValidationError{Field: "name", Message: "name is required"}
	assert.Equal(t, "name is required", e.Error())
}

func TestAlreadyImportedError_Error(t *testing.T) {
	e := &services.AlreadyImportedError{ExistingCourseID: uuid.New()}
	assert.Equal(t, "course already imported", e.Error())
}

func TestExternalAPIError_ErrorAndUnwrap(t *testing.T) {
	cause := errors.New("upstream 503")
	e := &services.ExternalAPIError{Cause: cause}
	assert.Contains(t, e.Error(), "upstream 503")
	assert.Equal(t, cause, e.Unwrap())
	// errors.Is walks Unwrap, so the wrapper must be matchable to its cause.
	assert.True(t, errors.Is(e, cause))
}
