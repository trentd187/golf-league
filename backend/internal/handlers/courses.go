// handlers/courses.go
// HTTP handlers for /api/v1/courses — course, tee, and hole management.
//
// Endpoints:
//
//	GET    /courses                                            — list all courses (searchable)
//	POST   /courses                                           — create a course manually
//	GET    /courses/:courseId                                 — full course detail with tees + holes
//	PATCH  /courses/:courseId                                 — update course fields
//	POST   /courses/:courseId/tees                            — add a tee set
//	PATCH  /courses/:courseId/tees/:teeId         — update a tee set
//	DELETE /courses/:courseId/tees/:teeId         — remove a tee set (cascades to holes)
//	PUT    /courses/:courseId/tees/:teeId/holes   — bulk-replace all holes for a tee
//	PATCH  /courses/:courseId/tees/:teeId/holes/:holeNumber — update a single hole
//
// Permission model:
//   - GET routes: any authenticated user
//   - All mutation routes: "admin" or "manager" role (enforced by RequireRole middleware)
//
// Active-round guard: any mutation that touches a course used by an active round is blocked
// with 409 Conflict. Course data changes mid-round would invalidate in-progress scores.
// Refresh is an explicit admin/manager action, never automatic.
package handlers

import (
	"strconv"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/trentd187/golf-league/internal/models"
	"github.com/trentd187/golf-league/internal/services"
	"gorm.io/gorm"
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
	Gender       string         `json:"gender"`        // "mens", "womens", or "unisex"
	CourseRating float64        `json:"course_rating"` // expected score for a scratch golfer, e.g. 72.4
	SlopeRating  int            `json:"slope_rating"`  // USGA slope 55–155
	Par          int            `json:"par"`
	Holes        []HoleResponse `json:"holes"`
}

// CourseSummaryResponse is the compact form used in the list endpoint.
// has_holes is true when at least one tee has hole data — mobile uses this to warn
// organizers before scheduling a round on an incomplete course.
type CourseSummaryResponse struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	City      string `json:"city"`
	State     string `json:"state"`
	HoleCount int    `json:"hole_count"`
	TeeCount  int    `json:"tee_count"`
	HasHoles  bool   `json:"has_holes"`
}

// CourseDetailResponse extends the summary with the full tee and hole data.
type CourseDetailResponse struct {
	CourseSummaryResponse
	Tees []TeeResponse `json:"tees"`
}

// ─── Request types ─────────────────────────────────────────────────────────────

// CreateCourseRequest is the body for POST /courses.
type CreateCourseRequest struct {
	Name      string `json:"name"` // required
	City      string `json:"city"`
	State     string `json:"state"`
	HoleCount int    `json:"hole_count"` // defaults to 18 if 0
}

// UpdateCourseRequest is the body for PATCH /courses/:courseId.
// All fields are optional pointers — only non-nil values are applied.
type UpdateCourseRequest struct {
	Name      *string `json:"name"`
	City      *string `json:"city"`
	State     *string `json:"state"`
	HoleCount *int    `json:"hole_count"`
}

// CreateTeeRequest is the body for POST /courses/:courseId/tees.
type CreateTeeRequest struct {
	Name         string  `json:"name"`          // required, e.g. "Blue"
	Gender       string  `json:"gender"`        // required: "mens", "womens", "unisex"
	CourseRating float64 `json:"course_rating"` // required
	SlopeRating  int     `json:"slope_rating"`  // required
	Par          int     `json:"par"`           // required
}

// UpdateTeeRequest is the body for PATCH /courses/:courseId/tees/:teeId.
// All fields are optional pointers.
type UpdateTeeRequest struct {
	Name         *string  `json:"name"`
	Gender       *string  `json:"gender"`
	CourseRating *float64 `json:"course_rating"`
	SlopeRating  *int     `json:"slope_rating"`
	Par          *int     `json:"par"`
}

// HoleInput is one hole entry in the bulk upsert request.
type HoleInput struct {
	HoleNumber  int  `json:"hole_number"` // 1–18
	Par         int  `json:"par"`
	StrokeIndex int  `json:"stroke_index"`
	Yardage     *int `json:"yardage"`
}

// UpsertHolesRequest is the body for PUT /courses/:courseId/tees/:teeId/holes.
// Replaces all existing holes for the tee in one atomic operation.
type UpsertHolesRequest struct {
	Holes []HoleInput `json:"holes"`
}

// UpdateHoleRequest is the body for PATCH /courses/:courseId/tees/:teeId/holes/:holeNumber.
type UpdateHoleRequest struct {
	Par         *int `json:"par"`
	StrokeIndex *int `json:"stroke_index"`
	Yardage     *int `json:"yardage"`
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

// parseCourseID parses the ":courseId" path parameter as a UUID.
// Returns (id, true) on success; writes a 400 response and returns (Nil, false) on failure.
// Callers should return nil immediately when the second value is false — the response
// has already been written, so there is nothing left for the handler to do.
func parseCourseID(c *fiber.Ctx) (uuid.UUID, bool) {
	id, err := uuid.Parse(c.Params("courseId"))
	if err != nil {
		_ = c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid course ID"})
		return uuid.Nil, false
	}
	return id, true
}

// parseTeeID parses the ":teeId" path parameter as a UUID.
// Returns (id, true) on success; writes a 400 response and returns (Nil, false) on failure.
func parseTeeID(c *fiber.Ctx) (uuid.UUID, bool) {
	id, err := uuid.Parse(c.Params("teeId"))
	if err != nil {
		_ = c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid tee ID"})
		return uuid.Nil, false
	}
	return id, true
}

// findCourse fetches a course by primary key.
// Returns (course, true) on success; writes a 404 response and returns (zero, false) if not found.
func findCourse(c *fiber.Ctx, db *gorm.DB, courseID uuid.UUID) (models.Course, bool) {
	var course models.Course
	if err := db.First(&course, "id = ?", courseID).Error; err != nil {
		_ = c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "course not found"})
		return models.Course{}, false
	}
	return course, true
}

// findTee fetches a tee by primary key and confirms it belongs to courseID.
// Returns (tee, true) on success; writes a 404 response and returns (zero, false) if not found.
func findTee(c *fiber.Ctx, db *gorm.DB, teeID, courseID uuid.UUID) (models.Tee, bool) {
	var tee models.Tee
	if err := db.First(&tee, "id = ? AND course_id = ?", teeID, courseID).Error; err != nil {
		_ = c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "tee not found"})
		return models.Tee{}, false
	}
	return tee, true
}

// buildHoleResponses converts a slice of Hole models into the JSON response shape.
func buildHoleResponses(holes []models.Hole) []HoleResponse {
	responses := make([]HoleResponse, 0, len(holes))
	for _, h := range holes {
		responses = append(responses, HoleResponse{
			HoleNumber:  h.HoleNumber,
			Par:         h.Par,
			StrokeIndex: h.StrokeIndex,
			Yardage:     h.Yardage,
		})
	}
	return responses
}

// buildTeeResponse converts a Tee model and its pre-built hole responses into
// the JSON response shape returned by the tee endpoints.
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

// activeRoundGuard returns a 409 Conflict response if any active round references
// the given course. Call this at the top of every mutating handler.
func activeRoundGuard(c *fiber.Ctx, db *gorm.DB, courseID uuid.UUID) (stop bool) {
	var count int64
	db.Model(&models.Round{}).
		Where("course_id = ? AND status = ?", courseID, models.RoundStatusActive).
		Count(&count)
	if count > 0 {
		_ = c.Status(fiber.StatusConflict).JSON(fiber.Map{
			"error": "cannot modify course data while an active round is in progress",
		})
		return true
	}
	return false
}

// insertExternalTees creates tee and hole records from GolfCourseAPI data inside
// an existing transaction. Extracted because ImportExternalCourse and RefreshCourse
// share the identical insertion logic.
func insertExternalTees(tx *gorm.DB, courseID uuid.UUID, extTees []services.ExternalTee) error {
	for _, extTee := range extTees {
		tee := models.Tee{
			CourseID:     courseID,
			Name:         extTee.TeeType,
			Gender:       mapExternalGender(extTee.Gender),
			CourseRating: extTee.CourseRating,
			SlopeRating:  extTee.SlopeRating,
			Par:          extTee.Par,
		}
		if err := tx.Create(&tee).Error; err != nil {
			return err
		}
		for _, extHole := range extTee.Holes {
			// The external API uses 0 to mean "no yardage" — store as NULL.
			var yardagePtr *int
			if extHole.Yardage > 0 {
				y := extHole.Yardage
				yardagePtr = &y
			}
			hole := models.Hole{
				TeeID:       tee.ID,
				HoleNumber:  extHole.HoleNumber,
				Par:         extHole.Par,
				StrokeIndex: extHole.StrokeIndex,
				Yardage:     yardagePtr,
			}
			if err := tx.Create(&hole).Error; err != nil {
				return err
			}
		}
	}
	return nil
}

// buildCourseDetail constructs a CourseDetailResponse from a loaded Course + Tees + Holes.
func buildCourseDetail(course models.Course) CourseDetailResponse {
	teeResponses := make([]TeeResponse, 0, len(course.Tees))
	hasHoles := false

	for _, tee := range course.Tees {
		holes := buildHoleResponses(tee.Holes)
		if len(holes) > 0 {
			hasHoles = true
		}
		teeResponses = append(teeResponses, buildTeeResponse(tee, holes))
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
		Tees: teeResponses,
	}
}

// loadCourseWithTees fetches a course and preloads its tees and holes.
func loadCourseWithTees(db *gorm.DB, courseID uuid.UUID) (models.Course, error) {
	var course models.Course
	err := db.Preload("Tees.Holes").First(&course, "id = ?", courseID).Error
	return course, err
}

// ─── Handlers ──────────────────────────────────────────────────────────────────

// GetCourses returns a handler for GET /api/v1/courses.
// Supports optional query params: ?name=, ?city=, ?state= (all case-insensitive, partial match).
func GetCourses(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		query := db.Model(&models.Course{})

		if name := strings.TrimSpace(c.Query("name")); name != "" {
			query = query.Where("name ILIKE ?", "%"+name+"%")
		}
		if city := strings.TrimSpace(c.Query("city")); city != "" {
			query = query.Where("city ILIKE ?", "%"+city+"%")
		}
		if state := strings.TrimSpace(c.Query("state")); state != "" {
			query = query.Where("state ILIKE ?", "%"+state+"%")
		}

		var courses []models.Course
		if err := query.Order("name ASC").Find(&courses).Error; err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to fetch courses"})
		}

		// Collect course IDs to count tees and holes in batch queries.
		courseIDs := make([]uuid.UUID, len(courses))
		for i, course := range courses {
			courseIDs[i] = course.ID
		}

		// Count tees per course in one query.
		type countRow struct {
			CourseID string
			Count    int
		}
		var teeCounts []countRow
		if len(courseIDs) > 0 {
			db.Model(&models.Tee{}).
				Select("course_id, COUNT(*) as count").
				Where("course_id IN ?", courseIDs).
				Group("course_id").
				Scan(&teeCounts)
		}
		teeCountMap := make(map[string]int, len(teeCounts))
		for _, row := range teeCounts {
			teeCountMap[row.CourseID] = row.Count
		}

		// Check which courses have at least one hole record (via tee join).
		type holeCheckRow struct {
			CourseID string
		}
		var holeChecks []holeCheckRow
		if len(courseIDs) > 0 {
			db.Model(&models.Hole{}).
				Select("tees.course_id").
				Joins("JOIN tees ON tees.id = holes.tee_id").
				Where("tees.course_id IN ?", courseIDs).
				Group("tees.course_id").
				Scan(&holeChecks)
		}
		hasHolesMap := make(map[string]bool, len(holeChecks))
		for _, row := range holeChecks {
			hasHolesMap[row.CourseID] = true
		}

		response := make([]CourseSummaryResponse, 0, len(courses))
		for _, course := range courses {
			idStr := course.ID.String()
			response = append(response, CourseSummaryResponse{
				ID:        idStr,
				Name:      course.Name,
				City:      course.City,
				State:     course.State,
				HoleCount: course.HoleCount,
				TeeCount:  teeCountMap[idStr],
				HasHoles:  hasHolesMap[idStr],
			})
		}

		return c.JSON(response)
	}
}

// GetCourse returns a handler for GET /api/v1/courses/:courseId.
// Returns full course detail including all tees and their holes.
func GetCourse(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		courseID, ok := parseCourseID(c)
		if !ok {
			return nil
		}

		course, err := loadCourseWithTees(db, courseID)
		if err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "course not found"})
		}

		return c.JSON(buildCourseDetail(course))
	}
}

// CreateCourse returns a handler for POST /api/v1/courses.
// Requires "admin" or "manager" role (enforced by RequireRole middleware).
func CreateCourse(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		var req CreateCourseRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
		}

		req.Name = strings.TrimSpace(req.Name)
		if req.Name == "" {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "name is required"})
		}
		if req.HoleCount == 0 {
			req.HoleCount = 18
		}
		if req.HoleCount != 9 && req.HoleCount != 18 {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "hole_count must be 9 or 18"})
		}

		course := models.Course{
			Name:      req.Name,
			City:      req.City,
			State:     req.State,
			HoleCount: req.HoleCount,
		}
		if err := db.Create(&course).Error; err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to create course"})
		}

		return c.Status(fiber.StatusCreated).JSON(buildCourseDetail(course))
	}
}

// UpdateCourse returns a handler for PATCH /api/v1/courses/:courseId.
// Requires "admin" or "manager" role. Blocked if an active round uses this course.
func UpdateCourse(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		courseID, ok := parseCourseID(c)
		if !ok {
			return nil
		}

		course, ok := findCourse(c, db, courseID)
		if !ok {
			return nil
		}

		if activeRoundGuard(c, db, courseID) {
			return nil
		}

		var req UpdateCourseRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
		}

		if req.Name != nil {
			trimmed := strings.TrimSpace(*req.Name)
			if trimmed == "" {
				return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "name cannot be empty"})
			}
			course.Name = trimmed
		}
		if req.City != nil {
			course.City = *req.City
		}
		if req.State != nil {
			course.State = *req.State
		}
		if req.HoleCount != nil {
			if *req.HoleCount != 9 && *req.HoleCount != 18 {
				return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "hole_count must be 9 or 18"})
			}
			course.HoleCount = *req.HoleCount
		}

		if err := db.Save(&course).Error; err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to update course"})
		}

		updated, err := loadCourseWithTees(db, courseID)
		if err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to reload course"})
		}
		return c.JSON(buildCourseDetail(updated))
	}
}

// CreateTee returns a handler for POST /api/v1/courses/:courseId/tees.
// Requires "admin" or "manager" role. Blocked if an active round uses this course.
func CreateTee(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		courseID, ok := parseCourseID(c)
		if !ok {
			return nil
		}

		if _, ok := findCourse(c, db, courseID); !ok {
			return nil
		}

		if activeRoundGuard(c, db, courseID) {
			return nil
		}

		var req CreateTeeRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
		}

		req.Name = strings.TrimSpace(req.Name)
		if req.Name == "" {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "name is required"})
		}
		switch req.Gender {
		case "mens", "womens", "unisex":
			// valid
		default:
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"error": "gender must be 'mens', 'womens', or 'unisex'",
			})
		}
		if req.CourseRating <= 0 {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "course_rating is required"})
		}
		if req.SlopeRating < 55 || req.SlopeRating > 155 {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "slope_rating must be between 55 and 155"})
		}
		if req.Par == 0 {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "par is required"})
		}

		tee := models.Tee{
			CourseID:     courseID,
			Name:         req.Name,
			Gender:       models.TeeGender(req.Gender),
			CourseRating: req.CourseRating,
			SlopeRating:  req.SlopeRating,
			Par:          req.Par,
		}
		if err := db.Create(&tee).Error; err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to create tee"})
		}

		return c.Status(fiber.StatusCreated).JSON(buildTeeResponse(tee, []HoleResponse{}))
	}
}

// UpdateTee returns a handler for PATCH /api/v1/courses/:courseId/tees/:teeId.
// Requires "admin" or "manager" role. Blocked if an active round uses this course.
func UpdateTee(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		courseID, ok := parseCourseID(c)
		if !ok {
			return nil
		}
		teeID, ok := parseTeeID(c)
		if !ok {
			return nil
		}

		if activeRoundGuard(c, db, courseID) {
			return nil
		}

		tee, ok := findTee(c, db, teeID, courseID)
		if !ok {
			return nil
		}

		var req UpdateTeeRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
		}

		if req.Name != nil {
			trimmed := strings.TrimSpace(*req.Name)
			if trimmed == "" {
				return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "name cannot be empty"})
			}
			tee.Name = trimmed
		}
		if req.Gender != nil {
			switch *req.Gender {
			case "mens", "womens", "unisex":
				tee.Gender = models.TeeGender(*req.Gender)
			default:
				return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
					"error": "gender must be 'mens', 'womens', or 'unisex'",
				})
			}
		}
		if req.CourseRating != nil {
			tee.CourseRating = *req.CourseRating
		}
		if req.SlopeRating != nil {
			if *req.SlopeRating < 55 || *req.SlopeRating > 155 {
				return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "slope_rating must be between 55 and 155"})
			}
			tee.SlopeRating = *req.SlopeRating
		}
		if req.Par != nil {
			tee.Par = *req.Par
		}

		if err := db.Save(&tee).Error; err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to update tee"})
		}

		var holes []models.Hole
		db.Where("tee_id = ?", teeID).Order("hole_number ASC").Find(&holes)

		return c.JSON(buildTeeResponse(tee, buildHoleResponses(holes)))
	}
}

// DeleteTee returns a handler for DELETE /api/v1/courses/:courseId/tees/:teeId.
// Cascades to all hole records. Blocked if an active round uses this course.
func DeleteTee(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		courseID, ok := parseCourseID(c)
		if !ok {
			return nil
		}
		teeID, ok := parseTeeID(c)
		if !ok {
			return nil
		}

		if activeRoundGuard(c, db, courseID) {
			return nil
		}

		tee, ok := findTee(c, db, teeID, courseID)
		if !ok {
			return nil
		}

		// ON DELETE CASCADE in the DB removes holes automatically.
		if err := db.Delete(&tee).Error; err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to delete tee"})
		}

		return c.SendStatus(fiber.StatusNoContent)
	}
}

// UpsertHoles returns a handler for PUT /api/v1/courses/:courseId/tees/:teeId/holes.
// Replaces all existing holes for the tee in one atomic transaction.
// Sending all holes at once (not one by one) matches how scorecards are entered in practice.
func UpsertHoles(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		courseID, ok := parseCourseID(c)
		if !ok {
			return nil
		}
		teeID, ok := parseTeeID(c)
		if !ok {
			return nil
		}

		if activeRoundGuard(c, db, courseID) {
			return nil
		}

		tee, ok := findTee(c, db, teeID, courseID)
		if !ok {
			return nil
		}

		var req UpsertHolesRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
		}
		if len(req.Holes) == 0 {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "holes array is required"})
		}

		// Validate hole numbers are unique and within range.
		seen := make(map[int]bool, len(req.Holes))
		for _, h := range req.Holes {
			if h.HoleNumber < 1 || h.HoleNumber > 18 {
				return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "hole_number must be between 1 and 18"})
			}
			if seen[h.HoleNumber] {
				return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "duplicate hole_number in request"})
			}
			seen[h.HoleNumber] = true
			if h.Par < 3 || h.Par > 5 {
				return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "hole par must be 3, 4, or 5"})
			}
		}

		// Replace all holes atomically: delete existing, insert new.
		txErr := db.Transaction(func(tx *gorm.DB) error {
			if err := tx.Where("tee_id = ?", teeID).Delete(&models.Hole{}).Error; err != nil {
				return err
			}
			for _, h := range req.Holes {
				hole := models.Hole{
					TeeID:       teeID,
					HoleNumber:  h.HoleNumber,
					Par:         h.Par,
					StrokeIndex: h.StrokeIndex,
					Yardage:     h.Yardage,
				}
				if err := tx.Create(&hole).Error; err != nil {
					return err
				}
			}
			return nil
		})
		if txErr != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to save holes"})
		}

		// Return the tee with its freshly-saved holes.
		var saved []models.Hole
		db.Where("tee_id = ?", teeID).Order("hole_number ASC").Find(&saved)

		return c.JSON(buildTeeResponse(tee, buildHoleResponses(saved)))
	}
}

// UpdateHole returns a handler for PATCH /api/v1/courses/:courseId/tees/:teeId/holes/:holeNumber.
// Updates a single hole. Blocked if an active round uses this course.
func UpdateHole(db *gorm.DB) fiber.Handler {
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
		if convErr != nil || holeNumber < 1 || holeNumber > 18 {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid hole number"})
		}

		if activeRoundGuard(c, db, courseID) {
			return nil
		}

		// Verify the tee belongs to the course.
		if _, ok := findTee(c, db, teeID, courseID); !ok {
			return nil
		}

		var hole models.Hole
		if err := db.First(&hole, "tee_id = ? AND hole_number = ?", teeID, holeNumber).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "hole not found"})
		}

		var req UpdateHoleRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
		}

		if req.Par != nil {
			if *req.Par < 3 || *req.Par > 5 {
				return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "par must be 3, 4, or 5"})
			}
			hole.Par = *req.Par
		}
		if req.StrokeIndex != nil {
			hole.StrokeIndex = *req.StrokeIndex
		}
		if req.Yardage != nil {
			hole.Yardage = req.Yardage
		}

		if err := db.Save(&hole).Error; err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to update hole"})
		}

		return c.JSON(HoleResponse{
			HoleNumber:  hole.HoleNumber,
			Par:         hole.Par,
			StrokeIndex: hole.StrokeIndex,
			Yardage:     hole.Yardage,
		})
	}
}

// ─── External API handlers ─────────────────────────────────────────────────────

// SearchExternalCourseRequest is the body for POST /courses/search-external.
type SearchExternalCourseRequest struct {
	Search string `json:"search"` // required — matches course name or club name
}

// ExternalCourseSummaryResponse is a single result from a course search.
// The client passes external_id back to import-external to trigger the import.
type ExternalCourseSummaryResponse struct {
	ExternalID string `json:"external_id"`
	Name       string `json:"name"`
	City       string `json:"city"`
	State      string `json:"state"`
	TeeCount   int    `json:"tee_count"`
}

// SearchExternalCourse returns a handler for POST /api/v1/courses/search-external.
// Queries GolfCourseAPI and returns matching courses — never writes to the DB.
// Requires "admin" or "manager" role (enforced by RequireRole middleware on the route).
func SearchExternalCourse(client *services.GolfCourseAPIClient) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if !client.IsConfigured() {
			return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{
				"error": "GOLF_COURSE_API_KEY is not configured — external course search is disabled",
			})
		}
		var req SearchExternalCourseRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
		}
		req.Search = strings.TrimSpace(req.Search)
		if req.Search == "" {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "search is required"})
		}

		results, err := client.Search(req.Search)
		if err != nil {
			return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"error": "external API search failed: " + err.Error()})
		}

		response := make([]ExternalCourseSummaryResponse, 0, len(results))
		for _, r := range results {
			name := r.CourseName
			if name == "" {
				name = r.ClubName
			}
			response = append(response, ExternalCourseSummaryResponse{
				ExternalID: strconv.Itoa(r.ID),
				Name:       name,
				City:       r.City,
				State:      r.State,
			})
		}

		return c.JSON(response)
	}
}

// ImportExternalCourseRequest is the body for POST /courses/import-external.
type ImportExternalCourseRequest struct {
	ExternalID string `json:"external_id"` // required — from search-external results
}

// ImportExternalCourse returns a handler for POST /api/v1/courses/import-external.
// Fetches full course data from GolfCourseAPI and creates the course, tees, and holes
// in a single transaction. Returns 409 if the course has already been imported.
func ImportExternalCourse(db *gorm.DB, client *services.GolfCourseAPIClient) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if !client.IsConfigured() {
			return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{
				"error": "GOLF_COURSE_API_KEY is not configured — external course import is disabled",
			})
		}
		var req ImportExternalCourseRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
		}
		req.ExternalID = strings.TrimSpace(req.ExternalID)
		if req.ExternalID == "" {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "external_id is required"})
		}

		// Check for duplicates before calling the external API.
		var existing models.Course
		if err := db.Where("external_source = 'golfcourseapi' AND external_id = ?", req.ExternalID).
			First(&existing).Error; err == nil {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{
				"error":     "course already imported",
				"course_id": existing.ID.String(),
			})
		}

		detail, err := client.FetchByID(req.ExternalID)
		if err != nil {
			return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"error": "external API fetch failed: " + err.Error()})
		}

		var created models.Course
		txErr := db.Transaction(func(tx *gorm.DB) error {
			name := detail.CourseName
			if name == "" {
				name = detail.ClubName
			}
			holeCount := detail.NumHoles
			if holeCount == 0 {
				holeCount = 18
			}

			created = models.Course{
				Name:           name,
				City:           detail.City,
				State:          detail.State,
				HoleCount:      holeCount,
				ExternalSource: "golfcourseapi",
				ExternalID:     strconv.Itoa(detail.ID),
			}
			if err := tx.Create(&created).Error; err != nil {
				return err
			}

			return insertExternalTees(tx, created.ID, detail.Tees)
		})
		if txErr != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to import course"})
		}

		full, err := loadCourseWithTees(db, created.ID)
		if err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to reload course"})
		}
		return c.Status(fiber.StatusCreated).JSON(buildCourseDetail(full))
	}
}

// RefreshCourse returns a handler for POST /api/v1/courses/:courseId/refresh.
// Re-pulls course data from GolfCourseAPI and replaces all tees and holes atomically.
// Only works for courses that were originally imported (have external_source set).
// Blocked if an active round is using this course.
func RefreshCourse(db *gorm.DB, client *services.GolfCourseAPIClient) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if !client.IsConfigured() {
			return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{
				"error": "GOLF_COURSE_API_KEY is not configured — course refresh is disabled",
			})
		}
		courseID, ok := parseCourseID(c)
		if !ok {
			return nil
		}

		course, ok := findCourse(c, db, courseID)
		if !ok {
			return nil
		}
		if course.ExternalSource == "" || course.ExternalID == "" {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"error": "course was not imported from an external API; use manual editing instead",
			})
		}

		if activeRoundGuard(c, db, courseID) {
			return nil
		}

		detail, err := client.FetchByID(course.ExternalID)
		if err != nil {
			return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"error": "external API fetch failed: " + err.Error()})
		}

		txErr := db.Transaction(func(tx *gorm.DB) error {
			// Delete all existing tees — ON DELETE CASCADE removes their holes automatically.
			if err := tx.Where("course_id = ?", courseID).Delete(&models.Tee{}).Error; err != nil {
				return err
			}
			return insertExternalTees(tx, courseID, detail.Tees)
		})
		if txErr != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to refresh course"})
		}

		full, err := loadCourseWithTees(db, courseID)
		if err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to reload course"})
		}
		return c.JSON(buildCourseDetail(full))
	}
}

// mapExternalGender converts GolfCourseAPI's gender string to our TeeGender enum.
// GolfCourseAPI uses "Male"/"Female"/empty; we use "mens"/"womens"/"unisex".
func mapExternalGender(g string) models.TeeGender {
	switch strings.ToLower(g) {
	case "male", "men", "mens":
		return models.TeeGenderMens
	case "female", "women", "womens":
		return models.TeeGenderWomens
	default:
		return models.TeeGenderUnisex
	}
}
