// handlers/courses.go
// HTTP handlers for /api/v1/courses — course, tee, and hole management.
//
// All business logic lives in internal/services.CourseService. Handlers here
// parse and validate the HTTP layer (URL params, JSON body, content types),
// call the service, and translate (value, error) into status codes + JSON.
//
// Endpoints:
//
//	GET    /courses                                            — list courses (filterable)
//	POST   /courses                                            — create a course manually
//	GET    /courses/:courseId                                  — full course detail
//	PATCH  /courses/:courseId                                  — patch course fields
//	POST   /courses/:courseId/tees                             — add a tee set
//	PATCH  /courses/:courseId/tees/:teeId                      — patch a tee set
//	DELETE /courses/:courseId/tees/:teeId                      — remove a tee set
//	PUT    /courses/:courseId/tees/:teeId/holes                — bulk-replace holes for a tee
//	PATCH  /courses/:courseId/tees/:teeId/holes/:holeNumber    — patch a single hole
//	POST   /courses/search-external                            — search GolfCourseAPI
//	POST   /courses/import-external                            — import a course from GolfCourseAPI
//	POST   /courses/:courseId/refresh                          — re-pull course data from GolfCourseAPI
//
// Permission model (enforced by middleware on the route, not in this file):
//   - GET routes: any authenticated user
//   - All mutations: "admin" role only
package handlers

import (
	"errors"
	"strconv"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/trentd187/golf-league/internal/models"
	"github.com/trentd187/golf-league/internal/services"
)

// ─── Response types ────────────────────────────────────────────────────────────

// HoleResponse is the per-hole data returned in a course detail response.
type HoleResponse struct {
	HoleNumber  int  `json:"hole_number"`
	Par         int  `json:"par"`
	StrokeIndex int  `json:"stroke_index"` // 1 = hardest hole (gets first handicap stroke)
	Yardage     *int `json:"yardage"`      // nullable — not all courses publish yardages
}

// TeeResponse describes one tee set, including all its holes.
type TeeResponse struct {
	ID           string         `json:"id"`
	Name         string         `json:"name"`
	Gender       string         `json:"gender"`
	CourseRating float64        `json:"course_rating"`
	SlopeRating  int            `json:"slope_rating"`
	Par          int            `json:"par"`
	Holes        []HoleResponse `json:"holes"`
}

// CourseSummaryResponse is the compact form used in the list endpoint.
type CourseSummaryResponse struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	City      string `json:"city"`
	State     string `json:"state"`
	HoleCount int    `json:"hole_count"`
	TeeCount  int    `json:"tee_count"`
	HasHoles  bool   `json:"has_holes"`
}

// CourseDetailResponse extends the summary with full tee + hole data.
type CourseDetailResponse struct {
	CourseSummaryResponse
	ExternalSource string        `json:"external_source"`
	Tees           []TeeResponse `json:"tees"`
}

// ExternalCourseSummaryResponse is one search result from GolfCourseAPI.
type ExternalCourseSummaryResponse struct {
	ExternalID string `json:"external_id"`
	Name       string `json:"name"`
	City       string `json:"city"`
	State      string `json:"state"`
	TeeCount   int    `json:"tee_count"`
}

// ─── Request types ─────────────────────────────────────────────────────────────

// CreateCourseRequest is the body for POST /courses.
type CreateCourseRequest struct {
	Name      string `json:"name"`
	City      string `json:"city"`
	State     string `json:"state"`
	HoleCount int    `json:"hole_count"`
}

// UpdateCourseRequest is the body for PATCH /courses/:courseId.
type UpdateCourseRequest struct {
	Name      *string `json:"name"`
	City      *string `json:"city"`
	State     *string `json:"state"`
	HoleCount *int    `json:"hole_count"`
}

// CreateTeeRequest is the body for POST /courses/:courseId/tees.
type CreateTeeRequest struct {
	Name         string  `json:"name"`
	Gender       string  `json:"gender"`
	CourseRating float64 `json:"course_rating"`
	SlopeRating  int     `json:"slope_rating"`
	Par          int     `json:"par"`
}

// UpdateTeeRequest is the body for PATCH /courses/:courseId/tees/:teeId.
type UpdateTeeRequest struct {
	Name         *string  `json:"name"`
	Gender       *string  `json:"gender"`
	CourseRating *float64 `json:"course_rating"`
	SlopeRating  *int     `json:"slope_rating"`
	Par          *int     `json:"par"`
}

// HoleInputRequest is one hole entry in the bulk-replace request.
type HoleInputRequest struct {
	HoleNumber  int  `json:"hole_number"`
	Par         int  `json:"par"`
	StrokeIndex int  `json:"stroke_index"`
	Yardage     *int `json:"yardage"`
}

// UpsertHolesRequest is the body for PUT /courses/:courseId/tees/:teeId/holes.
type UpsertHolesRequest struct {
	Holes []HoleInputRequest `json:"holes"`
}

// UpdateHoleRequest is the body for PATCH /courses/:courseId/tees/:teeId/holes/:holeNumber.
type UpdateHoleRequest struct {
	Par         *int `json:"par"`
	StrokeIndex *int `json:"stroke_index"`
	Yardage     *int `json:"yardage"`
}

// SearchExternalCourseRequest is the body for POST /courses/search-external.
type SearchExternalCourseRequest struct {
	Search   string `json:"search"`
	Location string `json:"location,omitempty"`
}

// ImportExternalCourseRequest is the body for POST /courses/import-external.
type ImportExternalCourseRequest struct {
	ExternalID string `json:"external_id"`
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

// parseCourseID parses the ":courseId" path parameter as a UUID.
// On failure, writes a 400 response and returns false; the caller should return nil.
func parseCourseID(c *fiber.Ctx) (uuid.UUID, bool) {
	id, err := uuid.Parse(c.Params("courseId"))
	if err != nil {
		_ = c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid course ID"})
		return uuid.Nil, false
	}
	return id, true
}

// parseTeeID parses the ":teeId" path parameter as a UUID.
func parseTeeID(c *fiber.Ctx) (uuid.UUID, bool) {
	id, err := uuid.Parse(c.Params("teeId"))
	if err != nil {
		_ = c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid tee ID"})
		return uuid.Nil, false
	}
	return id, true
}

// writeCourseError translates a service-level error into the appropriate HTTP
// response and (for any 5xx) records the underlying cause via c.Locals so the
// HTTPMetrics middleware can emit it as the `error` field of the http.error
// log line in Loki.
//
// Always returns nil — handlers do `return writeCourseError(c, err, ...)`.
//
//   - tag identifies the call site in logs (e.g. "course.refresh"). Search
//     Loki by `error=~"course.refresh.*"` to find every occurrence.
//   - fallbackMsg is the user-facing JSON error body for unknown errors that
//     map to a 500. Known errors (validation, not-found, etc.) use their own
//     specific messages and ignore this argument.
func writeCourseError(c *fiber.Ctx, err error, tag, fallbackMsg string) error {
	var ve *services.ValidationError
	if errors.As(err, &ve) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": ve.Message})
	}
	switch {
	case errors.Is(err, services.ErrCourseNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "course not found"})
	case errors.Is(err, services.ErrTeeNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "tee not found"})
	case errors.Is(err, services.ErrHoleNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "hole not found"})
	case errors.Is(err, services.ErrCourseInUse):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{
			"error": "cannot modify course data while an active round is in progress",
		})
	case errors.Is(err, services.ErrCourseNotExternal):
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "course was not imported from an external API; use manual editing instead",
		})
	case errors.Is(err, services.ErrExternalAPINotConfigured):
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{
			"error": "GOLF_COURSE_API_KEY is not configured — external course feature is disabled",
		})
	}

	var dup *services.AlreadyImportedError
	if errors.As(err, &dup) {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{
			"error":     "course already imported",
			"course_id": dup.ExistingCourseID.String(),
		})
	}

	// Upstream API errors get their cause logged as well as surfaced in the
	// response body — they're a class of failure where the *cause* (DNS,
	// 401 from provider, 5xx from provider, …) is the actual signal we want.
	var ext *services.ExternalAPIError
	if errors.As(err, &ext) {
		c.Locals("error_detail", tag+".external_api: "+ext.Cause.Error())
		return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{
			"error": "external API error: " + ext.Cause.Error(),
		})
	}

	// Unrecognised error → 500. Record the full cause for Loki; users get
	// the generic fallback message.
	c.Locals("error_detail", tag+": "+err.Error())
	return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": fallbackMsg})
}

func buildHoleResponses(holes []models.Hole) []HoleResponse {
	out := make([]HoleResponse, 0, len(holes))
	for _, h := range holes {
		out = append(out, HoleResponse{
			HoleNumber:  h.HoleNumber,
			Par:         h.Par,
			StrokeIndex: h.StrokeIndex,
			Yardage:     h.Yardage,
		})
	}
	return out
}

func buildTeeResponse(tee models.Tee, holes []HoleResponse) TeeResponse {
	return TeeResponse{
		ID:           tee.ID.String(),
		Name:         tee.Name,
		Gender:       string(tee.Gender),
		CourseRating: tee.CourseRating,
		SlopeRating:  tee.SlopeRating,
		Par:          tee.Par,
		Holes:        holes,
	}
}

func buildCourseDetail(course models.Course) CourseDetailResponse {
	tees := make([]TeeResponse, 0, len(course.Tees))
	hasHoles := false
	for _, tee := range course.Tees {
		holes := buildHoleResponses(tee.Holes)
		if len(holes) > 0 {
			hasHoles = true
		}
		tees = append(tees, buildTeeResponse(tee, holes))
	}
	return CourseDetailResponse{
		CourseSummaryResponse: CourseSummaryResponse{
			ID:        course.ID.String(),
			Name:      course.Name,
			City:      course.City,
			State:     course.State,
			HoleCount: course.HoleCount,
			TeeCount:  len(course.Tees),
			HasHoles:  hasHoles,
		},
		ExternalSource: course.ExternalSource,
		Tees:           tees,
	}
}

// ─── Handlers ──────────────────────────────────────────────────────────────────

// GetCourses returns a handler for GET /api/v1/courses.
// Supports optional query params: q, name, location, city, state.
func GetCourses(svc *services.CourseService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		items, err := svc.List(c.UserContext(), services.ListFilters{
			Q:        c.Query("q"),
			Name:     c.Query("name"),
			Location: c.Query("location"),
			City:     c.Query("city"),
			State:    c.Query("state"),
		})
		if err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to fetch courses"})
		}

		out := make([]CourseSummaryResponse, 0, len(items))
		for _, item := range items {
			out = append(out, CourseSummaryResponse{
				ID:        item.Course.ID.String(),
				Name:      item.Course.Name,
				City:      item.Course.City,
				State:     item.Course.State,
				HoleCount: item.Course.HoleCount,
				TeeCount:  item.TeeCount,
				HasHoles:  item.HasHoles,
			})
		}
		return c.JSON(out)
	}
}

// GetCourse returns a handler for GET /api/v1/courses/:courseId.
func GetCourse(svc *services.CourseService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		courseID, ok := parseCourseID(c)
		if !ok {
			return nil
		}
		course, err := svc.Get(c.UserContext(), courseID)
		if err != nil {
			return writeCourseError(c, err, "course.get", "failed to fetch course")
		}
		return c.JSON(buildCourseDetail(course))
	}
}

// CreateCourse returns a handler for POST /api/v1/courses.
func CreateCourse(svc *services.CourseService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		var req CreateCourseRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
		}
		course, err := svc.Create(c.UserContext(), services.CourseInput{
			Name:      req.Name,
			City:      req.City,
			State:     req.State,
			HoleCount: req.HoleCount,
		})
		if err != nil {
			return writeCourseError(c, err, "course.create", "failed to create course")
		}
		return c.Status(fiber.StatusCreated).JSON(buildCourseDetail(course))
	}
}

// UpdateCourse returns a handler for PATCH /api/v1/courses/:courseId.
func UpdateCourse(svc *services.CourseService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		courseID, ok := parseCourseID(c)
		if !ok {
			return nil
		}
		var req UpdateCourseRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
		}
		course, err := svc.Update(c.UserContext(), courseID, services.CourseUpdate{
			Name:      req.Name,
			City:      req.City,
			State:     req.State,
			HoleCount: req.HoleCount,
		})
		if err != nil {
			return writeCourseError(c, err, "course.update", "failed to update course")
		}
		return c.JSON(buildCourseDetail(course))
	}
}

// CreateTee returns a handler for POST /api/v1/courses/:courseId/tees.
func CreateTee(svc *services.CourseService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		courseID, ok := parseCourseID(c)
		if !ok {
			return nil
		}
		var req CreateTeeRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
		}
		tee, err := svc.CreateTee(c.UserContext(), courseID, services.TeeInput{
			Name:         req.Name,
			Gender:       req.Gender,
			CourseRating: req.CourseRating,
			SlopeRating:  req.SlopeRating,
			Par:          req.Par,
		})
		if err != nil {
			return writeCourseError(c, err, "tee.create", "failed to create tee")
		}
		return c.Status(fiber.StatusCreated).JSON(buildTeeResponse(tee, []HoleResponse{}))
	}
}

// UpdateTee returns a handler for PATCH /api/v1/courses/:courseId/tees/:teeId.
func UpdateTee(svc *services.CourseService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		courseID, ok := parseCourseID(c)
		if !ok {
			return nil
		}
		teeID, ok := parseTeeID(c)
		if !ok {
			return nil
		}
		var req UpdateTeeRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
		}
		tee, holes, err := svc.UpdateTee(c.UserContext(), courseID, teeID, services.TeeUpdate{
			Name:         req.Name,
			Gender:       req.Gender,
			CourseRating: req.CourseRating,
			SlopeRating:  req.SlopeRating,
			Par:          req.Par,
		})
		if err != nil {
			return writeCourseError(c, err, "tee.update", "failed to update tee")
		}
		return c.JSON(buildTeeResponse(tee, buildHoleResponses(holes)))
	}
}

// DeleteTee returns a handler for DELETE /api/v1/courses/:courseId/tees/:teeId.
func DeleteTee(svc *services.CourseService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		courseID, ok := parseCourseID(c)
		if !ok {
			return nil
		}
		teeID, ok := parseTeeID(c)
		if !ok {
			return nil
		}
		if err := svc.DeleteTee(c.UserContext(), courseID, teeID); err != nil {
			return writeCourseError(c, err, "tee.delete", "failed to delete tee")
		}
		return c.SendStatus(fiber.StatusNoContent)
	}
}

// UpsertHoles returns a handler for PUT /api/v1/courses/:courseId/tees/:teeId/holes.
func UpsertHoles(svc *services.CourseService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		courseID, ok := parseCourseID(c)
		if !ok {
			return nil
		}
		teeID, ok := parseTeeID(c)
		if !ok {
			return nil
		}
		var req UpsertHolesRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
		}
		holes := make([]services.HoleInput, len(req.Holes))
		for i, h := range req.Holes {
			holes[i] = services.HoleInput{
				HoleNumber:  h.HoleNumber,
				Par:         h.Par,
				StrokeIndex: h.StrokeIndex,
				Yardage:     h.Yardage,
			}
		}
		tee, saved, err := svc.UpsertHoles(c.UserContext(), courseID, teeID, holes)
		if err != nil {
			return writeCourseError(c, err, "holes.upsert", "failed to save holes")
		}
		return c.JSON(buildTeeResponse(tee, buildHoleResponses(saved)))
	}
}

// UpdateHole returns a handler for PATCH /api/v1/courses/:courseId/tees/:teeId/holes/:holeNumber.
func UpdateHole(svc *services.CourseService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		courseID, ok := parseCourseID(c)
		if !ok {
			return nil
		}
		teeID, ok := parseTeeID(c)
		if !ok {
			return nil
		}
		holeNumber, convErr := strconv.Atoi(c.Params("holeNumber"))
		if convErr != nil {
			// Service treats negative/out-of-range as ValidationError, but a non-numeric
			// segment never even reaches it — reject here.
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid hole number"})
		}
		var req UpdateHoleRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
		}
		hole, err := svc.UpdateHole(c.UserContext(), courseID, teeID, holeNumber, services.HoleUpdate{
			Par:         req.Par,
			StrokeIndex: req.StrokeIndex,
			Yardage:     req.Yardage,
		})
		if err != nil {
			return writeCourseError(c, err, "hole.update", "failed to update hole")
		}
		return c.JSON(HoleResponse{
			HoleNumber:  hole.HoleNumber,
			Par:         hole.Par,
			StrokeIndex: hole.StrokeIndex,
			Yardage:     hole.Yardage,
		})
	}
}

// ─── External-API handlers ─────────────────────────────────────────────────────

// SearchExternalCourse returns a handler for POST /api/v1/courses/search-external.
func SearchExternalCourse(svc *services.CourseService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		var req SearchExternalCourseRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
		}
		results, err := svc.SearchExternal(c.UserContext(), req.Search, req.Location)
		if err != nil {
			return writeCourseError(c, err, "course.search_external", "search failed")
		}
		out := make([]ExternalCourseSummaryResponse, 0, len(results))
		for _, r := range results {
			out = append(out, ExternalCourseSummaryResponse(r))
		}
		return c.JSON(out)
	}
}

// ImportExternalCourse returns a handler for POST /api/v1/courses/import-external.
func ImportExternalCourse(svc *services.CourseService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		var req ImportExternalCourseRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
		}
		course, err := svc.ImportExternal(c.UserContext(), req.ExternalID)
		if err != nil {
			return writeCourseError(c, err, "course.import_external", "failed to import course")
		}
		return c.Status(fiber.StatusCreated).JSON(buildCourseDetail(course))
	}
}

// RefreshCourse returns a handler for POST /api/v1/courses/:courseId/refresh.
func RefreshCourse(svc *services.CourseService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		// Service checks IsConfigured first, but we do the UUID parse here so the
		// 400-on-bad-UUID path stays observable in handler tests without a service.
		courseID, ok := parseCourseID(c)
		if !ok {
			return nil
		}
		course, err := svc.Refresh(c.UserContext(), courseID)
		if err != nil {
			return writeCourseError(c, err, "course.refresh", "failed to refresh course")
		}
		return c.JSON(buildCourseDetail(course))
	}
}
