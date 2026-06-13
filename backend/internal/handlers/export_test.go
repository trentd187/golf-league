// export_test.go
// Re-exports unexported symbols so the black-box handlers_test package can
// call them directly in unit tests without touching the public API surface.
package handlers

// WriteCourseErrorExported exposes writeCourseError so tests can verify the
// status mapping and the error_detail visibility hook directly, without
// having to fabricate a service call that returns each error variant.
var WriteCourseErrorExported = writeCourseError
var WriteScoreErrorExported = writeScoreError
var WriteRoundErrorExported = writeRoundError
var WriteEventErrorExported = writeEventError
var WriteUserErrorExported = writeUserError
var UUIDPtrStrExported = uuidPtrStr

// Pure helper functions — no fiber context required.
var FormatOptionalDateExported = formatOptionalDate
var FormatTeeTimeExported = formatTeeTime
var ToGroupResponseExported = toGroupResponse
var ToTeamResponseExported = toTeamResponse
var BuildEventResponseExported = buildEventResponse
var BuildMemberResponseExported = buildMemberResponse
var BuildHoleResponsesExported = buildHoleResponses
var BuildTeeResponseExported = buildTeeResponse
var BuildCourseDetailExported = buildCourseDetail
