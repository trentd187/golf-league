// Package services holds all business logic for the Golf League API.
//
// Each domain owns one file (<domain>_service.go) with a single exported
// struct (e.g. CourseService, EventService). Handlers in internal/handlers/
// are thin HTTP adapters: they parse the request, call a service method, and
// map the result to an HTTP response via a write<Domain>Error helper.
//
// # Service catalog
//
//   - CourseService  — courses, tees, holes, external GolfCourseAPI import/refresh
//   - EventService   — events, event members, round list within an event
//   - RoundService   — round scheduling, groups, group-member assignment
//   - ScoreService   — scorecard assembly, score entry, handicap gate, hole stats
//   - UserService    — profile lookup, follow/unfollow, career stats, scorecard settings
//
// # Sentinel errors
//
// Service methods return typed sentinel errors for expected failure modes so
// that handlers can map them to precise HTTP status codes without inspecting
// error strings.
//
// Shared across the package (declared once, used by multiple services):
//
//	ErrUserNotFound     — no users row for the given UUID (event_service.go)
//	ErrCourseNotFound   — no courses row for the given UUID
//	ErrCourseInUse      — course is referenced by an existing round
//	ValidationError     — structured validation failure (field, message); maps to 400
//
// UserService-specific:
//
//	ErrFollowSelf       — caller and target are the same user
//	ErrAlreadyFollowing — follow row already exists
//
// EventService-specific:
//
//	ErrEventNotFound, ErrNotOrganizer, ErrAlreadyMember, ErrMemberNotFound
//
// RoundService-specific:
//
//	ErrRoundNotFound, ErrGroupNotFound, ErrNotRoundOrganizer, ErrGroupMemberNotFound
//
// ScoreService-specific:
//
//	ErrRoundPlayerNotFound, ErrHandicapRequired, ErrNotInSameGroup, ErrRoundNotOpen
//
// # Permission model
//
// The "admin" global role bypasses organizer checks. All other roles must hold
// the "organizer" event_player entry for the specific event (EventService.IsOrganizer)
// or be the scheduling user for the round (RoundService.IsOrganizer). These checks
// are called inside service methods — handlers do not implement permission logic directly.
package services
