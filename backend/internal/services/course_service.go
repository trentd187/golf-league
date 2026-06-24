// services/course_service.go
// CourseService owns all business logic for courses, tees, and holes.
// Handlers in internal/handlers/courses.go are thin wrappers that:
//   - parse request input,
//   - call a CourseService method,
//   - map the returned (value, error) to an HTTP status + JSON body.
//
// Validation, the active-round guard, and external-API orchestration all live
// here. This keeps the service callable from any caller (HTTP, CLI, jobs) and
// keeps the test surface small: service tests use a real Postgres via
// testutil.NewTestDB; handler tests stay focused on HTTP plumbing.
//
// Error contract:
//   - Inputs that fail validation return a *ValidationError with a Field/Message.
//   - "Not found" conditions return one of ErrCourseNotFound / ErrTeeNotFound / ErrHoleNotFound.
//   - Other domain conditions return their own sentinel: ErrCourseInUse,
//     ErrCourseNotExternal, ErrExternalAPINotConfigured, *AlreadyImportedError.
//   - Anything else is a wrapped infrastructure error (DB, external API).
package services

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/trentd187/golf-league/internal/models"
	"gorm.io/gorm"
)

// ─── Sentinel errors ───────────────────────────────────────────────────────────

var (
	// ErrCourseNotFound is returned when a course lookup misses.
	ErrCourseNotFound = errors.New("course not found")
	// ErrTeeNotFound is returned when a tee lookup misses (or the tee doesn't belong to the course).
	ErrTeeNotFound = errors.New("tee not found")
	// ErrHoleNotFound is returned when a single-hole lookup misses.
	ErrHoleNotFound = errors.New("hole not found")
	// ErrCourseInUse is returned by any mutation that would change a course while
	// an active round references it. Course data changes mid-round would invalidate
	// in-progress scores.
	ErrCourseInUse = errors.New("cannot modify course data while an active round is in progress")
	// ErrCourseHasRounds is returned by Delete when any round (of any status)
	// references the course. rounds.course_id is intentionally non-cascading, so a
	// referenced course can't be hard-deleted without orphaning round history.
	ErrCourseHasRounds = errors.New("cannot delete a course that is referenced by one or more rounds")
	// ErrCourseNotExternal is returned by Refresh when called on a manually-entered course.
	ErrCourseNotExternal = errors.New("course was not imported from an external API; use manual editing instead")
	// ErrExternalAPINotConfigured is returned when an external-API operation runs
	// without a GolfCourseAPI client configured.
	ErrExternalAPINotConfigured = errors.New("external course API is not configured")
)

// ValidationError describes an input value that failed validation.
// Field is a stable machine-readable name; Message is the human-readable reason.
// Handlers serialise Message into the JSON `error` field.
type ValidationError struct {
	Field   string
	Message string
}

func (e *ValidationError) Error() string { return e.Message }

// AlreadyImportedError signals that the supplied external_id has already been
// imported. ExistingCourseID lets callers surface the existing course to the user.
type AlreadyImportedError struct {
	ExistingCourseID uuid.UUID
}

func (e *AlreadyImportedError) Error() string { return "course already imported" }

// ExternalAPIError wraps any failure from the external GolfCourseAPI so callers
// can distinguish upstream issues from local infrastructure failures.
type ExternalAPIError struct{ Cause error }

func (e *ExternalAPIError) Error() string { return "external API error: " + e.Cause.Error() }
func (e *ExternalAPIError) Unwrap() error { return e.Cause }

// ─── Inputs and DTOs ───────────────────────────────────────────────────────────

// CourseInput carries the fields needed to create a course.
// HoleCount = 0 is treated as 18 (the common default).
type CourseInput struct {
	Name      string
	City      string
	State     string
	HoleCount int
}

// CourseUpdate carries optional patches to an existing course.
// All fields are pointers — only non-nil values are applied.
type CourseUpdate struct {
	Name      *string
	City      *string
	State     *string
	HoleCount *int
}

// TeeInput carries the fields needed to create a tee.
// Empty Gender is treated as "unisex".
type TeeInput struct {
	Name         string
	Gender       string
	CourseRating float64
	SlopeRating  int
	Par          int
}

// TeeUpdate carries optional patches to an existing tee.
type TeeUpdate struct {
	Name         *string
	Gender       *string
	CourseRating *float64
	SlopeRating  *int
	Par          *int
}

// HoleInput is one hole entry for the bulk-replace endpoint.
type HoleInput struct {
	HoleNumber  int
	Par         int
	StrokeIndex int
	Yardage     *int
}

// HoleUpdate carries optional patches to a single hole.
type HoleUpdate struct {
	Par         *int
	StrokeIndex *int
	Yardage     *int
}

// ListFilters describes optional case-insensitive filters for List.
type ListFilters struct {
	Q        string // free-text OR over name/city/state
	Name     string
	Location string // OR over city/state
	City     string
	State    string
}

// CourseListItem is a single row in a List result: the course plus the two
// derived counts the mobile UI displays in its course list.
type CourseListItem struct {
	Course   models.Course
	TeeCount int
	HasHoles bool
}

// ExternalCourseSummary is one search result returned by SearchExternal.
type ExternalCourseSummary struct {
	ExternalID string
	Name       string
	City       string
	State      string
	TeeCount   int
}

// ─── Constructor ───────────────────────────────────────────────────────────────

// CourseService bundles a DB handle and (optionally) a GolfCourseAPI client.
// Construct one in main.go and inject it into handler factories.
type CourseService struct {
	DB     *gorm.DB
	Client *GolfCourseAPIClient // may be nil when GOLF_COURSE_API_KEY is unset
}

// NewCourseService builds a service. Either argument may be nil for tests that
// only exercise validation paths.
func NewCourseService(db *gorm.DB, client *GolfCourseAPIClient) *CourseService {
	return &CourseService{DB: db, Client: client}
}

// ─── Read methods ──────────────────────────────────────────────────────────────

// List returns all courses matching the given filter set, ordered by name.
// TeeCount and HasHoles are computed in two batched queries to avoid N+1.
func (s *CourseService) List(ctx context.Context, f ListFilters) ([]CourseListItem, error) {
	query := s.DB.WithContext(ctx).Model(&models.Course{})

	if q := strings.TrimSpace(f.Q); q != "" {
		like := "%" + q + "%"
		query = query.Where("name ILIKE ? OR city ILIKE ? OR state ILIKE ?", like, like, like)
	}
	if name := strings.TrimSpace(f.Name); name != "" {
		query = query.Where("name ILIKE ?", "%"+name+"%")
	}
	if loc := strings.TrimSpace(f.Location); loc != "" {
		query = query.Where("city ILIKE ? OR state ILIKE ?", "%"+loc+"%", "%"+loc+"%")
	}
	if city := strings.TrimSpace(f.City); city != "" {
		query = query.Where("city ILIKE ?", "%"+city+"%")
	}
	if state := strings.TrimSpace(f.State); state != "" {
		query = query.Where("state ILIKE ?", "%"+state+"%")
	}

	var courses []models.Course
	if err := query.Order("name ASC").Find(&courses).Error; err != nil {
		return nil, fmt.Errorf("list courses: %w", err)
	}

	if len(courses) == 0 {
		return []CourseListItem{}, nil
	}

	courseIDs := make([]uuid.UUID, len(courses))
	for i, c := range courses {
		courseIDs[i] = c.ID
	}

	// Tees per course in one grouped query.
	type countRow struct {
		CourseID string
		Count    int
	}
	var teeCounts []countRow
	if err := s.DB.WithContext(ctx).Model(&models.Tee{}).
		Select("course_id, COUNT(*) as count").
		Where("course_id IN ?", courseIDs).
		Group("course_id").
		Scan(&teeCounts).Error; err != nil {
		return nil, fmt.Errorf("count tees: %w", err)
	}
	teeCountMap := make(map[string]int, len(teeCounts))
	for _, row := range teeCounts {
		teeCountMap[row.CourseID] = row.Count
	}

	// Which courses have at least one hole record (via tee join).
	type holeCheckRow struct{ CourseID string }
	var holeChecks []holeCheckRow
	if err := s.DB.WithContext(ctx).Model(&models.Hole{}).
		Select("tees.course_id").
		Joins("JOIN tees ON tees.id = holes.tee_id").
		Where("tees.course_id IN ?", courseIDs).
		Group("tees.course_id").
		Scan(&holeChecks).Error; err != nil {
		return nil, fmt.Errorf("check hole presence: %w", err)
	}
	hasHolesMap := make(map[string]bool, len(holeChecks))
	for _, row := range holeChecks {
		hasHolesMap[row.CourseID] = true
	}

	out := make([]CourseListItem, len(courses))
	for i, c := range courses {
		idStr := c.ID.String()
		out[i] = CourseListItem{
			Course:   c,
			TeeCount: teeCountMap[idStr],
			HasHoles: hasHolesMap[idStr],
		}
	}
	return out, nil
}

// Get returns the full course detail including all tees and their holes.
func (s *CourseService) Get(ctx context.Context, courseID uuid.UUID) (models.Course, error) {
	var course models.Course
	err := s.DB.WithContext(ctx).Preload("Tees.Holes").First(&course, "id = ?", courseID).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return models.Course{}, ErrCourseNotFound
		}
		return models.Course{}, fmt.Errorf("load course: %w", err)
	}
	return course, nil
}

// ─── Mutation methods ──────────────────────────────────────────────────────────

// Create validates the input and inserts a new course.
func (s *CourseService) Create(ctx context.Context, in CourseInput) (models.Course, error) {
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		return models.Course{}, &ValidationError{Field: "name", Message: "name is required"}
	}
	if in.HoleCount == 0 {
		in.HoleCount = 18
	}
	if in.HoleCount != 9 && in.HoleCount != 18 {
		return models.Course{}, &ValidationError{Field: "hole_count", Message: "hole_count must be 9 or 18"}
	}

	course := models.Course{
		Name:      in.Name,
		City:      in.City,
		State:     in.State,
		HoleCount: in.HoleCount,
	}
	if err := s.DB.WithContext(ctx).Create(&course).Error; err != nil {
		return models.Course{}, fmt.Errorf("create course: %w", err)
	}
	return course, nil
}

// Update applies the patch to the course identified by courseID.
// Returns the freshly reloaded course (with tees/holes preloaded).
// Blocked with ErrCourseInUse when an active round references the course.
func (s *CourseService) Update(ctx context.Context, courseID uuid.UUID, in CourseUpdate) (models.Course, error) {
	course, err := s.findCourse(ctx, courseID)
	if err != nil {
		return models.Course{}, err
	}
	if err := s.guardActiveRound(ctx, courseID); err != nil {
		return models.Course{}, err
	}

	if in.Name != nil {
		trimmed := strings.TrimSpace(*in.Name)
		if trimmed == "" {
			return models.Course{}, &ValidationError{Field: "name", Message: "name cannot be empty"}
		}
		course.Name = trimmed
	}
	if in.City != nil {
		course.City = *in.City
	}
	if in.State != nil {
		course.State = *in.State
	}
	if in.HoleCount != nil {
		if *in.HoleCount != 9 && *in.HoleCount != 18 {
			return models.Course{}, &ValidationError{Field: "hole_count", Message: "hole_count must be 9 or 18"}
		}
		course.HoleCount = *in.HoleCount
	}

	if err := s.DB.WithContext(ctx).Save(&course).Error; err != nil {
		return models.Course{}, fmt.Errorf("save course: %w", err)
	}
	return s.Get(ctx, courseID)
}

// Delete removes a course. Tees and holes cascade via the DB schema, but a course
// referenced by any round is blocked with ErrCourseHasRounds (rounds.course_id is
// non-cascading by design — deleting the course would otherwise orphan round history).
func (s *CourseService) Delete(ctx context.Context, courseID uuid.UUID) error {
	course, err := s.findCourse(ctx, courseID)
	if err != nil {
		return err
	}
	if err := s.guardCourseReferenced(ctx, courseID); err != nil {
		return err
	}
	if err := s.DB.WithContext(ctx).Delete(&course).Error; err != nil {
		return fmt.Errorf("delete course: %w", err)
	}
	return nil
}

// CreateTee adds a new tee set to a course.
func (s *CourseService) CreateTee(ctx context.Context, courseID uuid.UUID, in TeeInput) (models.Tee, error) {
	if _, err := s.findCourse(ctx, courseID); err != nil {
		return models.Tee{}, err
	}
	if err := s.guardActiveRound(ctx, courseID); err != nil {
		return models.Tee{}, err
	}

	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		return models.Tee{}, &ValidationError{Field: "name", Message: "name is required"}
	}
	// Default gender to "unisex" when not provided. Mobile UI does not expose
	// gender; tee names (Blue, White, Red) are the meaningful identifier.
	if in.Gender == "" {
		in.Gender = "unisex"
	}
	if !isValidGender(in.Gender) {
		return models.Tee{}, &ValidationError{Field: "gender", Message: "gender must be 'mens', 'womens', or 'unisex'"}
	}
	if in.CourseRating <= 0 {
		return models.Tee{}, &ValidationError{Field: "course_rating", Message: "course_rating is required"}
	}
	if in.SlopeRating < 55 || in.SlopeRating > 155 {
		return models.Tee{}, &ValidationError{Field: "slope_rating", Message: "slope_rating must be between 55 and 155"}
	}
	if in.Par == 0 {
		return models.Tee{}, &ValidationError{Field: "par", Message: "par is required"}
	}

	tee := models.Tee{
		CourseID:     courseID,
		Name:         in.Name,
		Gender:       models.TeeGender(in.Gender),
		CourseRating: in.CourseRating,
		SlopeRating:  in.SlopeRating,
		Par:          in.Par,
	}
	if err := s.DB.WithContext(ctx).Create(&tee).Error; err != nil {
		return models.Tee{}, fmt.Errorf("create tee: %w", err)
	}
	return tee, nil
}

// UpdateTee applies a patch to a tee. Returns the saved tee plus its current
// holes (so handlers can render the full tee response).
func (s *CourseService) UpdateTee(ctx context.Context, courseID, teeID uuid.UUID, in TeeUpdate) (models.Tee, []models.Hole, error) {
	if err := s.guardActiveRound(ctx, courseID); err != nil {
		return models.Tee{}, nil, err
	}
	tee, err := s.findTee(ctx, teeID, courseID)
	if err != nil {
		return models.Tee{}, nil, err
	}

	if in.Name != nil {
		trimmed := strings.TrimSpace(*in.Name)
		if trimmed == "" {
			return models.Tee{}, nil, &ValidationError{Field: "name", Message: "name cannot be empty"}
		}
		tee.Name = trimmed
	}
	if in.Gender != nil {
		if !isValidGender(*in.Gender) {
			return models.Tee{}, nil, &ValidationError{Field: "gender", Message: "gender must be 'mens', 'womens', or 'unisex'"}
		}
		tee.Gender = models.TeeGender(*in.Gender)
	}
	if in.CourseRating != nil {
		tee.CourseRating = *in.CourseRating
	}
	if in.SlopeRating != nil {
		if *in.SlopeRating < 55 || *in.SlopeRating > 155 {
			return models.Tee{}, nil, &ValidationError{Field: "slope_rating", Message: "slope_rating must be between 55 and 155"}
		}
		tee.SlopeRating = *in.SlopeRating
	}
	if in.Par != nil {
		tee.Par = *in.Par
	}

	if err := s.DB.WithContext(ctx).Save(&tee).Error; err != nil {
		return models.Tee{}, nil, fmt.Errorf("save tee: %w", err)
	}

	var holes []models.Hole
	if err := s.DB.WithContext(ctx).Where("tee_id = ?", teeID).Order("hole_number ASC").Find(&holes).Error; err != nil {
		return models.Tee{}, nil, fmt.Errorf("load holes: %w", err)
	}
	return tee, holes, nil
}

// DeleteTee removes a tee. Holes are cascaded by the DB schema.
func (s *CourseService) DeleteTee(ctx context.Context, courseID, teeID uuid.UUID) error {
	if err := s.guardActiveRound(ctx, courseID); err != nil {
		return err
	}
	tee, err := s.findTee(ctx, teeID, courseID)
	if err != nil {
		return err
	}
	if err := s.DB.WithContext(ctx).Delete(&tee).Error; err != nil {
		return fmt.Errorf("delete tee: %w", err)
	}
	return nil
}

// UpsertHoles atomically replaces every hole on a tee with the supplied set.
// All input is validated up-front; the delete + inserts run inside a transaction.
func (s *CourseService) UpsertHoles(ctx context.Context, courseID, teeID uuid.UUID, holes []HoleInput) (models.Tee, []models.Hole, error) {
	if err := s.guardActiveRound(ctx, courseID); err != nil {
		return models.Tee{}, nil, err
	}
	tee, err := s.findTee(ctx, teeID, courseID)
	if err != nil {
		return models.Tee{}, nil, err
	}
	// Bound hole numbers to the course's hole count so a 9-hole course can't be
	// given holes 10–18 (and vice versa). HoleCount 0 is legacy data → treat as 18.
	course, err := s.findCourse(ctx, courseID)
	if err != nil {
		return models.Tee{}, nil, err
	}
	holeCount := course.HoleCount
	if holeCount == 0 {
		holeCount = 18
	}

	if len(holes) == 0 {
		return models.Tee{}, nil, &ValidationError{Field: "holes", Message: "holes array is required"}
	}
	seen := make(map[int]bool, len(holes))
	for _, h := range holes {
		if h.HoleNumber < 1 || h.HoleNumber > holeCount {
			return models.Tee{}, nil, &ValidationError{Field: "hole_number", Message: fmt.Sprintf("hole_number must be between 1 and %d", holeCount)}
		}
		if seen[h.HoleNumber] {
			return models.Tee{}, nil, &ValidationError{Field: "hole_number", Message: "duplicate hole_number in request"}
		}
		seen[h.HoleNumber] = true
		if h.Par < 3 || h.Par > 5 {
			return models.Tee{}, nil, &ValidationError{Field: "par", Message: "hole par must be 3, 4, or 5"}
		}
	}

	txErr := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("tee_id = ?", teeID).Delete(&models.Hole{}).Error; err != nil {
			return err
		}
		for _, h := range holes {
			row := models.Hole{
				TeeID:       teeID,
				HoleNumber:  h.HoleNumber,
				Par:         h.Par,
				StrokeIndex: h.StrokeIndex,
				Yardage:     h.Yardage,
			}
			if err := tx.Create(&row).Error; err != nil {
				return err
			}
		}
		return nil
	})
	if txErr != nil {
		return models.Tee{}, nil, fmt.Errorf("save holes: %w", txErr)
	}

	var saved []models.Hole
	if err := s.DB.WithContext(ctx).Where("tee_id = ?", teeID).Order("hole_number ASC").Find(&saved).Error; err != nil {
		return models.Tee{}, nil, fmt.Errorf("reload holes: %w", err)
	}
	return tee, saved, nil
}

// UpdateHole patches a single hole identified by tee + hole number.
func (s *CourseService) UpdateHole(ctx context.Context, courseID, teeID uuid.UUID, holeNumber int, in HoleUpdate) (models.Hole, error) {
	if holeNumber < 1 || holeNumber > 18 {
		return models.Hole{}, &ValidationError{Field: "hole_number", Message: "invalid hole number"}
	}
	if err := s.guardActiveRound(ctx, courseID); err != nil {
		return models.Hole{}, err
	}
	if _, err := s.findTee(ctx, teeID, courseID); err != nil {
		return models.Hole{}, err
	}

	var hole models.Hole
	if err := s.DB.WithContext(ctx).First(&hole, "tee_id = ? AND hole_number = ?", teeID, holeNumber).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return models.Hole{}, ErrHoleNotFound
		}
		return models.Hole{}, fmt.Errorf("load hole: %w", err)
	}

	if in.Par != nil {
		if *in.Par < 3 || *in.Par > 5 {
			return models.Hole{}, &ValidationError{Field: "par", Message: "par must be 3, 4, or 5"}
		}
		hole.Par = *in.Par
	}
	if in.StrokeIndex != nil {
		hole.StrokeIndex = *in.StrokeIndex
	}
	if in.Yardage != nil {
		hole.Yardage = in.Yardage
	}

	if err := s.DB.WithContext(ctx).Save(&hole).Error; err != nil {
		return models.Hole{}, fmt.Errorf("save hole: %w", err)
	}
	return hole, nil
}

// ─── External-API methods ──────────────────────────────────────────────────────

// SearchExternal queries GolfCourseAPI for courses matching the user's input.
// search is required; location (city/state/zip) is optional and is appended to
// the API's free-text search term to narrow results.
func (s *CourseService) SearchExternal(ctx context.Context, search, location string) ([]ExternalCourseSummary, error) {
	_ = ctx // GolfCourseAPI client is not yet ctx-aware; keep parity with other methods.
	if s.Client == nil || !s.Client.IsConfigured() {
		return nil, ErrExternalAPINotConfigured
	}
	search = strings.TrimSpace(search)
	location = strings.TrimSpace(location)
	if search == "" {
		return nil, &ValidationError{Field: "search", Message: "search is required"}
	}
	term := search
	if location != "" {
		term = search + " " + location
	}

	results, err := s.Client.Search(term)
	if err != nil {
		return nil, &ExternalAPIError{Cause: err}
	}

	out := make([]ExternalCourseSummary, 0, len(results))
	for _, r := range results {
		name := r.CourseName
		if name == "" {
			name = r.ClubName
		}
		out = append(out, ExternalCourseSummary{
			ExternalID: strconv.Itoa(r.ID),
			Name:       name,
			City:       r.Location.City,
			State:      r.Location.State,
			TeeCount:   len(r.Tees.Male) + len(r.Tees.Female),
		})
	}
	return out, nil
}

// ImportExternal fetches the full course from GolfCourseAPI and creates the
// course + all tees + all holes inside a single transaction.
// Returns *AlreadyImportedError if the external_id is already in our DB.
func (s *CourseService) ImportExternal(ctx context.Context, externalID string) (models.Course, error) {
	if s.Client == nil || !s.Client.IsConfigured() {
		return models.Course{}, ErrExternalAPINotConfigured
	}
	externalID = strings.TrimSpace(externalID)
	if externalID == "" {
		return models.Course{}, &ValidationError{Field: "external_id", Message: "external_id is required"}
	}

	// Fail fast on duplicate before paying the external-API round-trip.
	var existing models.Course
	if err := s.DB.WithContext(ctx).
		Where("external_source = 'golfcourseapi' AND external_id = ?", externalID).
		First(&existing).Error; err == nil {
		return models.Course{}, &AlreadyImportedError{ExistingCourseID: existing.ID}
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return models.Course{}, fmt.Errorf("dup-check: %w", err)
	}

	detail, err := s.Client.FetchByID(externalID)
	if err != nil {
		return models.Course{}, &ExternalAPIError{Cause: err}
	}

	var created models.Course
	txErr := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		name := detail.CourseName
		if name == "" {
			name = detail.ClubName
		}
		// Derive hole count from the first tee that declares it; default 18.
		holeCount := 18
		if len(detail.Tees.Male) > 0 && detail.Tees.Male[0].NumHoles > 0 {
			holeCount = detail.Tees.Male[0].NumHoles
		} else if len(detail.Tees.Female) > 0 && detail.Tees.Female[0].NumHoles > 0 {
			holeCount = detail.Tees.Female[0].NumHoles
		}

		created = models.Course{
			Name:           name,
			City:           detail.Location.City,
			State:          detail.Location.State,
			HoleCount:      holeCount,
			ExternalSource: "golfcourseapi",
			ExternalID:     strconv.Itoa(detail.ID),
		}
		if err := tx.Create(&created).Error; err != nil {
			return fmt.Errorf("create course: %w", err)
		}
		if err := upsertExternalTees(tx, created.ID, detail.Tees); err != nil {
			return fmt.Errorf("insert tees: %w", err)
		}
		return nil
	})
	if txErr != nil {
		return models.Course{}, fmt.Errorf("import external course %s: %w", externalID, txErr)
	}

	return s.Get(ctx, created.ID)
}

// Refresh re-pulls course data from GolfCourseAPI and replaces all tees and
// holes atomically. Only valid for courses originally imported (ExternalSource
// + ExternalID set) and not currently being played.
func (s *CourseService) Refresh(ctx context.Context, courseID uuid.UUID) (models.Course, error) {
	if s.Client == nil || !s.Client.IsConfigured() {
		return models.Course{}, ErrExternalAPINotConfigured
	}
	course, err := s.findCourse(ctx, courseID)
	if err != nil {
		return models.Course{}, err
	}
	if course.ExternalSource == "" || course.ExternalID == "" {
		return models.Course{}, ErrCourseNotExternal
	}
	if err := s.guardActiveRound(ctx, courseID); err != nil {
		return models.Course{}, err
	}

	detail, err := s.Client.FetchByID(course.ExternalID)
	if err != nil {
		return models.Course{}, &ExternalAPIError{Cause: err}
	}

	// Upsert (don't delete-then-insert) so we don't break rounds.default_tee_id
	// FKs on scheduled or completed rounds. Tees are matched by (course_id, name)
	// so an existing tee's ID is preserved and the round keeps pointing at it
	// after refresh. Tees in the DB but not in the external response are left
	// alone — they may be manually-added or referenced by old rounds; users
	// can prune them via DELETE /courses/:courseId/tees/:teeId.
	txErr := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := upsertExternalTees(tx, courseID, detail.Tees); err != nil {
			return fmt.Errorf("upsert tees: %w", err)
		}
		return nil
	})
	if txErr != nil {
		return models.Course{}, fmt.Errorf("refresh course %s: %w", courseID, txErr)
	}

	return s.Get(ctx, courseID)
}

// ─── Private helpers ───────────────────────────────────────────────────────────

func (s *CourseService) findCourse(ctx context.Context, courseID uuid.UUID) (models.Course, error) {
	var course models.Course
	if err := s.DB.WithContext(ctx).First(&course, "id = ?", courseID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return models.Course{}, ErrCourseNotFound
		}
		return models.Course{}, fmt.Errorf("find course: %w", err)
	}
	return course, nil
}

func (s *CourseService) findTee(ctx context.Context, teeID, courseID uuid.UUID) (models.Tee, error) {
	var tee models.Tee
	if err := s.DB.WithContext(ctx).First(&tee, "id = ? AND course_id = ?", teeID, courseID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return models.Tee{}, ErrTeeNotFound
		}
		return models.Tee{}, fmt.Errorf("find tee: %w", err)
	}
	return tee, nil
}

// guardActiveRound returns ErrCourseInUse if any active round references the course.
func (s *CourseService) guardActiveRound(ctx context.Context, courseID uuid.UUID) error {
	var count int64
	if err := s.DB.WithContext(ctx).Model(&models.Round{}).
		Where("course_id = ? AND status = ?", courseID, models.RoundStatusActive).
		Count(&count).Error; err != nil {
		return fmt.Errorf("active-round check: %w", err)
	}
	if count > 0 {
		return ErrCourseInUse
	}
	return nil
}

// guardCourseReferenced returns ErrCourseHasRounds if any round (of any status)
// references the course. Used by Delete — broader than guardActiveRound, which
// only blocks active rounds, because the rounds.course_id FK is non-cascading.
func (s *CourseService) guardCourseReferenced(ctx context.Context, courseID uuid.UUID) error {
	var count int64
	if err := s.DB.WithContext(ctx).Model(&models.Round{}).
		Where("course_id = ?", courseID).
		Count(&count).Error; err != nil {
		return fmt.Errorf("course-reference check: %w", err)
	}
	if count > 0 {
		return ErrCourseHasRounds
	}
	return nil
}

func isValidGender(g string) bool {
	switch g {
	case "mens", "womens", "unisex":
		return true
	}
	return false
}

// upsertExternalTees applies a GolfCourseAPI tee set to courseID inside an
// existing transaction. Shared by Import and Refresh.
//
// Match key is (course_id, name): a tee with the same name is UPDATEd in
// place (preserving its ID, so rounds.default_tee_id FKs stay valid); a tee
// not yet in the DB is INSERTed. Tees in the DB but absent from the external
// response are left alone — they may be manually-added or referenced by old
// rounds; users prune them via the DELETE tee endpoint.
//
// GolfCourseAPI splits tees by gender into separate male[] / female[] arrays.
// The same physical tee can appear in both — we deduplicate by name, preferring
// whichever copy has more complete hole data.
func upsertExternalTees(tx *gorm.DB, courseID uuid.UUID, tees ExternalCourseTees) error {
	type candidate struct {
		tee    ExternalTeeBox
		gender models.TeeGender
	}
	best := make(map[string]candidate)
	for _, t := range tees.Male {
		best[t.TeeName] = candidate{t, models.TeeGenderMens}
	}
	for _, t := range tees.Female {
		existing, dup := best[t.TeeName]
		if !dup {
			best[t.TeeName] = candidate{t, models.TeeGenderWomens}
			continue
		}
		// Same name in both arrays — keep whichever has more holes; tiebreak male.
		if len(t.Holes) > len(existing.tee.Holes) {
			best[t.TeeName] = candidate{t, models.TeeGenderWomens}
		}
	}

	inserted := make(map[string]bool)
	for _, t := range tees.Male {
		c := best[t.TeeName]
		if err := upsertOneTee(tx, courseID, c.tee, c.gender); err != nil {
			return fmt.Errorf("insert tee %q (%s): %w", c.tee.TeeName, c.gender, err)
		}
		inserted[t.TeeName] = true
	}
	for _, t := range tees.Female {
		if inserted[t.TeeName] {
			continue
		}
		if err := upsertOneTee(tx, courseID, t, models.TeeGenderWomens); err != nil {
			return fmt.Errorf("insert tee %q (womens): %w", t.TeeName, err)
		}
		inserted[t.TeeName] = true
	}
	return nil
}

// upsertOneTee writes a single tee + all its holes inside an existing transaction.
//
// If a tee with the same (course_id, name) already exists, it is UPDATEd in
// place (preserving its ID so rounds.default_tee_id FKs remain valid) and its
// existing holes are deleted before re-inserting. Otherwise a new tee row is
// created. Holes have no inbound FKs from elsewhere, so the wholesale replace
// is safe.
//
// Hole numbers are positional (array index + 1) — GolfCourseAPI has no
// hole_number field. par_total can be 0 even with hole-level pars; in that
// case we sum the per-hole pars.
func upsertOneTee(tx *gorm.DB, courseID uuid.UUID, extTee ExternalTeeBox, gender models.TeeGender) error {
	par := extTee.Par
	if par == 0 && len(extTee.Holes) > 0 {
		for _, h := range extTee.Holes {
			par += h.Par
		}
	}

	var tee models.Tee
	lookupErr := tx.Where("course_id = ? AND name = ?", courseID, extTee.TeeName).
		First(&tee).Error
	switch {
	case errors.Is(lookupErr, gorm.ErrRecordNotFound):
		tee = models.Tee{
			CourseID:     courseID,
			Name:         extTee.TeeName,
			Gender:       gender,
			CourseRating: extTee.CourseRating,
			SlopeRating:  extTee.SlopeRating,
			Par:          par,
		}
		if err := tx.Create(&tee).Error; err != nil {
			// Surface the source values that triggered the constraint so we can
			// diagnose without re-running. Common culprits: slope_rating outside
			// 55–155 and course_rating overflowing decimal(4,1).
			return fmt.Errorf("create tee row (rating=%v slope=%d par=%d): %w",
				extTee.CourseRating, extTee.SlopeRating, par, err)
		}
	case lookupErr != nil:
		return fmt.Errorf("lookup existing tee: %w", lookupErr)
	default:
		// Existing tee — keep its ID (rounds.default_tee_id depends on it),
		// update mutable fields, and replace its holes below.
		tee.Gender = gender
		tee.CourseRating = extTee.CourseRating
		tee.SlopeRating = extTee.SlopeRating
		tee.Par = par
		if err := tx.Save(&tee).Error; err != nil {
			return fmt.Errorf("update tee row (rating=%v slope=%d par=%d): %w",
				extTee.CourseRating, extTee.SlopeRating, par, err)
		}
		if err := tx.Where("tee_id = ?", tee.ID).Delete(&models.Hole{}).Error; err != nil {
			return fmt.Errorf("clear existing holes: %w", err)
		}
	}
	for i, extHole := range extTee.Holes {
		var yardage *int
		if extHole.Yardage > 0 {
			y := extHole.Yardage
			yardage = &y
		}
		if err := tx.Create(&models.Hole{
			TeeID:       tee.ID,
			HoleNumber:  i + 1,
			Par:         extHole.Par,
			StrokeIndex: extHole.StrokeIndex,
			Yardage:     yardage,
		}).Error; err != nil {
			return fmt.Errorf("create hole %d (par=%d si=%d): %w",
				i+1, extHole.Par, extHole.StrokeIndex, err)
		}
	}
	return nil
}
