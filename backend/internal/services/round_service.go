// services/round_service.go
// RoundService owns all business logic for rounds and their tee-time groups.
// Handlers in internal/handlers/rounds.go and handlers/events.go are thin
// wrappers that parse HTTP input, call methods here, and translate the
// (value, error) results into HTTP status + JSON via writeRoundError.
//
// Permission model:
//   - "admin" global role → can manage ANY round.
//   - Everyone else → must hold the "organizer" event_player role for the
//     event that owns the round. IsRoundOrganizer delegates to EventService.IsOrganizer.
//
// Error contract:
//   - Input validation failures return *ValidationError (Field + Message).
//   - Not-found conditions return ErrRoundNotFound / ErrGroupNotFound.
//   - Forbidden mutations return ErrRoundForbidden.
//   - Domain conflicts return ErrGroupFull / ErrPlayerAlreadyInGroup /
//     ErrPlayerNotEventMember / ErrPlayerNotInRound.
//   - Infrastructure errors are wrapped: fmt.Errorf("step: %w", err).
package services

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/trentd187/golf-league/internal/models"
	"gorm.io/gorm"
)

// ─── Field-name constants ─────────────────────────────────────────────────────
// Prevents S1192 duplicate-literal findings for strings repeated 3+ times
// across the Schedule, Update, and CreateEventlessRound validation blocks.
const (
	colScheduledDate     = "scheduled_date"
	colDefaultTeeID      = "default_tee_id"
	colNineHoleSelection = "nine_hole_selection"
	nineHoleFront        = "front"
	nineHoleBack         = "back"
)

// ─── Sentinel errors ───────────────────────────────────────────────────────────

var (
	// ErrRoundNotFound — no round with the requested ID.
	ErrRoundNotFound = errors.New("round not found")
	// ErrGroupNotFound — group does not exist or does not belong to the round.
	ErrGroupNotFound = errors.New("group not found")
	// ErrRoundForbidden — caller is not an organizer of the event that owns the round.
	ErrRoundForbidden = errors.New("not authorized for this round")
	// ErrGroupFull — group already has 4 players (the maximum).
	ErrGroupFull = errors.New("group is full (max 4 players)")
	// ErrPlayerAlreadyInGroup — the player is already in another group for this round.
	ErrPlayerAlreadyInGroup = errors.New("player is already assigned to a group in this round")
	// ErrPlayerNotEventMember — the target user is not a member of the event.
	ErrPlayerNotEventMember = errors.New("user is not a member of this event")
	// ErrPlayerNotInRound — the target player has no RoundPlayer record for this round.
	ErrPlayerNotInRound = errors.New("player is not registered for this round")
)

// ─── Input types ───────────────────────────────────────────────────────────────

// ScheduleRoundInput is the validated payload accepted by Schedule.
type ScheduleRoundInput struct {
	Name          string
	ScheduledDate string // "YYYY-MM-DD"
	ScoringFormat *string
	// CourseID (UUID string) is the preferred course selector. Requires DefaultTeeID.
	CourseID     *string
	DefaultTeeID *string
	// CourseName is the legacy find-or-create fallback. Prefer CourseID.
	CourseName        string
	NineHoleSelection *string // "front" or "back"; only valid for 18-hole courses
	Groups            []GroupScheduleInput
}

// GroupScheduleInput is one initial tee-time group in a Schedule call.
// TeeTime accepts "15:04" or "3:04 PM"; unparseable values are silently ignored.
type GroupScheduleInput struct {
	TeeTime *string
}

// UpdateRoundInput is the optional-fields payload for Update.
// nil pointer means leave the field alone.
type UpdateRoundInput struct {
	Name          *string
	ScheduledDate *string // "YYYY-MM-DD"
	ScoringFormat *string
	Status        *string // "scheduled", "active", or "completed"
	// CourseID requires DefaultTeeID when set.
	CourseID     *string
	DefaultTeeID *string
	// CourseName is the legacy find-or-create fallback.
	CourseName *string
}

// UpdateGroupInput is the optional-fields payload for UpdateGroup.
// nil = leave alone; pointer to "" = clear; pointer to value = set.
type UpdateGroupInput struct {
	Name    *string
	TeeTime *string // "HH:MM" or "H:MM AM/PM"
}

// ─── Result types ─────────────────────────────────────────────────────────────

// ScheduleRoundResult is returned by Schedule.
type ScheduleRoundResult struct {
	Round      models.Round
	CourseName string
	GroupCount int
}

// RoundUpdateResult is returned by Update: the saved round + its course name.
type RoundUpdateResult struct {
	Round      models.Round
	CourseName string
}

// MyRoundResult is one row in a GetMyRounds list.
// EventName is nil for eventless rounds (no associated event).
type MyRoundResult struct {
	Round        models.Round
	EventName    *string
	CourseName   string
	TeeName      string
	TeePar       int
	CourseRating float64
	SlopeRating  int
	GroupCount   int
}

// RoundDetailResult is returned by Get: the round, its organizer flag, and groups.
type RoundDetailResult struct {
	Round       models.Round
	IsOrganizer bool
	Groups      []GroupDetailResult
}

// GroupDetailResult is one tee-time group with its current players.
type GroupDetailResult struct {
	Group   models.Group
	Players []GroupPlayerResult
}

// GroupMutationResult is returned by group mutations (CreateGroup, UpdateGroup, AddGroupMember).
type GroupMutationResult struct {
	Group   models.Group
	Players []GroupPlayerResult
}

// GroupPlayerResult is one player within a group, joined from group_players → round_players → users.
type GroupPlayerResult struct {
	RoundPlayerID string
	UserID        string
	DisplayName   string
	Email         string
	AvatarURL     *string
}

// ─── Constructor ───────────────────────────────────────────────────────────────

// RoundService owns round and tee-time group business logic.
// Construct once in main.go and inject into every rounds handler factory.
type RoundService struct {
	DB       *gorm.DB
	EventSvc *EventService
}

// NewRoundService builds a RoundService. EventSvc is required for the
// IsOrganizer check shared with EventService.
func NewRoundService(db *gorm.DB, eventSvc *EventService) *RoundService {
	return &RoundService{DB: db, EventSvc: eventSvc}
}

// ─── Permission helper ─────────────────────────────────────────────────────────

// IsRoundOrganizer reports whether the caller has organizer rights over roundID.
// For event-linked rounds it delegates to EventService.IsOrganizer.
// For eventless rounds it checks that the caller is the round's creator (or a platform admin).
// Returns ErrRoundNotFound if the round does not exist.
func (s *RoundService) IsRoundOrganizer(ctx context.Context, roundID, userID uuid.UUID, userRole string) (bool, error) {
	var round models.Round
	if err := s.DB.WithContext(ctx).Select("id, event_id, created_by").First(&round, "id = ?", roundID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return false, ErrRoundNotFound
		}
		return false, fmt.Errorf("load round for organizer check: %w", err)
	}
	if round.EventID != nil {
		return s.EventSvc.IsOrganizer(ctx, *round.EventID, userID, userRole)
	}
	// Eventless round: platform admins and the creator are organizers.
	if userRole == string(models.UserRoleAdmin) {
		return true, nil
	}
	return round.CreatedBy != nil && *round.CreatedBy == userID, nil
}

// ─── Read methods ─────────────────────────────────────────────────────────────

// GetMyRounds returns all rounds the user is a player in (both event-linked and
// eventless), ordered by scheduled_date descending.
func (s *RoundService) GetMyRounds(ctx context.Context, userID uuid.UUID) ([]MyRoundResult, error) {
	// Use round_players.user_id directly — covers both event-linked rounds
	// (backfilled in migration 000020) and eventless rounds.
	var roundPlayers []models.RoundPlayer
	if err := s.DB.WithContext(ctx).Select("round_id").Where("user_id = ?", userID).
		Find(&roundPlayers).Error; err != nil {
		return nil, fmt.Errorf("load round memberships: %w", err)
	}
	if len(roundPlayers) == 0 {
		return []MyRoundResult{}, nil
	}

	roundIDs := make([]uuid.UUID, len(roundPlayers))
	for i, rp := range roundPlayers {
		roundIDs[i] = rp.RoundID
	}

	var rounds []models.Round
	if err := s.DB.WithContext(ctx).Preload("Course").Preload("Event").Preload("DefaultTee").
		Where("id IN ?", roundIDs).
		Order("scheduled_date DESC").
		Find(&rounds).Error; err != nil {
		return nil, fmt.Errorf("load rounds: %w", err)
	}
	if len(rounds) == 0 {
		return []MyRoundResult{}, nil
	}

	// Batch group counts to avoid N+1 queries.
	type countRow struct {
		RoundID string
		Count   int
	}
	var countRows []countRow
	if err := s.DB.WithContext(ctx).Model(&models.Group{}).
		Select("round_id, COUNT(*) as count").
		Where("round_id IN ?", roundIDs).
		Group("round_id").
		Scan(&countRows).Error; err != nil {
		return nil, fmt.Errorf("count groups: %w", err)
	}
	countMap := make(map[string]int, len(countRows))
	for _, row := range countRows {
		countMap[row.RoundID] = row.Count
	}

	out := make([]MyRoundResult, len(rounds))
	for i, r := range rounds {
		var eventName *string
		if r.Event != nil {
			n := r.Event.Name
			eventName = &n
		}
		out[i] = MyRoundResult{
			Round:        r,
			EventName:    eventName,
			CourseName:   r.Course.Name,
			TeeName:      r.DefaultTee.Name,
			TeePar:       r.DefaultTee.Par,
			CourseRating: r.DefaultTee.CourseRating,
			SlopeRating:  r.DefaultTee.SlopeRating,
			GroupCount:   countMap[r.ID.String()],
		}
	}
	return out, nil
}

// Get returns the full detail for a round, including groups and their players.
// IsOrganizer is computed here so the handler does not need a second service call.
func (s *RoundService) Get(ctx context.Context, roundID, callerID uuid.UUID, callerRole string) (RoundDetailResult, error) {
	var round models.Round
	if err := s.DB.WithContext(ctx).Preload("Course").First(&round, "id = ?", roundID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return RoundDetailResult{}, ErrRoundNotFound
		}
		return RoundDetailResult{}, fmt.Errorf("load round: %w", err)
	}

	isOrg, err := s.IsRoundOrganizer(ctx, roundID, callerID, callerRole)
	if err != nil {
		return RoundDetailResult{}, err
	}

	var groups []models.Group
	if err := s.DB.WithContext(ctx).Where("round_id = ?", roundID).Order("group_number ASC").Find(&groups).Error; err != nil {
		return RoundDetailResult{}, fmt.Errorf("load groups: %w", err)
	}

	groupResults := make([]GroupDetailResult, len(groups))
	for i, g := range groups {
		players, err := s.loadGroupPlayers(ctx, g.ID)
		if err != nil {
			return RoundDetailResult{}, err
		}
		groupResults[i] = GroupDetailResult{Group: g, Players: players}
	}

	return RoundDetailResult{
		Round:       round,
		IsOrganizer: isOrg,
		Groups:      groupResults,
	}, nil
}

// ─── Mutations ─────────────────────────────────────────────────────────────────

// Schedule creates a round under an event along with its initial tee-time groups.
// Previously the body of ScheduleEventRound in handlers/events.go.
func (s *RoundService) Schedule(ctx context.Context, eventID, callerID uuid.UUID, callerRole string, in ScheduleRoundInput) (ScheduleRoundResult, error) {
	// Validate before any DB access so Tier 1 handler tests reach these without a DB.
	if in.CourseID == nil && in.CourseName == "" {
		return ScheduleRoundResult{}, &ValidationError{Field: "course", Message: "course_id or course_name is required"}
	}
	if in.CourseID != nil && in.DefaultTeeID == nil {
		return ScheduleRoundResult{}, &ValidationError{Field: colDefaultTeeID, Message: "default_tee_id is required when course_id is provided"}
	}
	if in.ScheduledDate == "" {
		return ScheduleRoundResult{}, &ValidationError{Field: colScheduledDate, Message: "scheduled_date is required"}
	}
	scheduledDate, err := time.Parse("2006-01-02", in.ScheduledDate)
	if err != nil {
		return ScheduleRoundResult{}, &ValidationError{Field: colScheduledDate, Message: "scheduled_date must be YYYY-MM-DD"}
	}
	if in.NineHoleSelection != nil {
		sel := *in.NineHoleSelection
		if sel != nineHoleFront && sel != nineHoleBack {
			return ScheduleRoundResult{}, &ValidationError{Field: colNineHoleSelection, Message: `nine_hole_selection must be "front" or "back"`}
		}
	}

	authorized, err := s.EventSvc.IsOrganizer(ctx, eventID, callerID, callerRole)
	if err != nil {
		return ScheduleRoundResult{}, fmt.Errorf("check organizer: %w", err)
	}
	if !authorized {
		return ScheduleRoundResult{}, ErrRoundForbidden
	}

	scoringFormat := models.ScoringFormatStroke
	if in.ScoringFormat != nil && *in.ScoringFormat != "" {
		scoringFormat = models.ScoringFormat(*in.ScoringFormat)
	}

	groupInputs := in.Groups
	if len(groupInputs) == 0 {
		groupInputs = []GroupScheduleInput{{}}
	}

	var createdRound models.Round
	var courseName string

	txErr := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var course models.Course
		var teeID uuid.UUID

		if in.CourseID != nil {
			courseUUID, err := uuid.Parse(*in.CourseID)
			if err != nil {
				return &ValidationError{Field: "course_id", Message: "invalid course_id"}
			}
			if err := tx.First(&course, "id = ?", courseUUID).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return ErrCourseNotFound
				}
				return fmt.Errorf("load course: %w", err)
			}
			teeUUID, err := uuid.Parse(*in.DefaultTeeID)
			if err != nil {
				return &ValidationError{Field: colDefaultTeeID, Message: "invalid default_tee_id"}
			}
			var tee models.Tee
			if err := tx.First(&tee, "id = ? AND course_id = ?", teeUUID, courseUUID).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return ErrTeeNotFound
				}
				return fmt.Errorf("load tee: %w", err)
			}
			teeID = teeUUID
		} else {
			// Legacy find-or-create by name — mirrors the pre-service handler behavior.
			if err := tx.Where("name ILIKE ?", in.CourseName).First(&course).Error; err != nil {
				course = models.Course{Name: in.CourseName, HoleCount: 18}
				if err := tx.Create(&course).Error; err != nil {
					return fmt.Errorf("create course: %w", err)
				}
				defaultTee := models.Tee{
					CourseID:     course.ID,
					Name:         "Default",
					Gender:       models.TeeGenderUnisex,
					CourseRating: 72.0,
					SlopeRating:  113,
					Par:          72,
				}
				if err := tx.Create(&defaultTee).Error; err != nil {
					return fmt.Errorf("create default tee: %w", err)
				}
				teeID = defaultTee.ID
			} else {
				var tee models.Tee
				if err := tx.Where("course_id = ?", course.ID).First(&tee).Error; err != nil {
					tee = models.Tee{
						CourseID:     course.ID,
						Name:         "Default",
						Gender:       models.TeeGenderUnisex,
						CourseRating: 72.0,
						SlopeRating:  113,
						Par:          72,
					}
					if err := tx.Create(&tee).Error; err != nil {
						return fmt.Errorf("create default tee: %w", err)
					}
				}
				teeID = tee.ID
			}
		}

		courseName = course.Name

		if in.NineHoleSelection != nil && course.HoleCount != 18 {
			return &ValidationError{Field: colNineHoleSelection, Message: "nine_hole_selection is only valid for 18-hole courses"}
		}

		var roundCount int64
		tx.Model(&models.Round{}).Where("event_id = ?", eventID).Count(&roundCount)
		nextRoundNumber := int(roundCount) + 1

		roundName := in.Name
		if roundName == "" {
			roundName = fmt.Sprintf("Round %d", nextRoundNumber)
		}

		createdRound = models.Round{
			EventID:           &eventID,
			CourseID:          course.ID,
			DefaultTeeID:      teeID,
			Name:              roundName,
			RoundNumber:       nextRoundNumber,
			ScheduledDate:     scheduledDate,
			Status:            models.RoundStatusScheduled,
			ScoringFormat:     scoringFormat,
			RequiresHandicap:  false,
			NineHoleSelection: in.NineHoleSelection,
		}
		if err := tx.Create(&createdRound).Error; err != nil {
			return fmt.Errorf("create round: %w", err)
		}

		for i, g := range groupInputs {
			group := models.Group{
				RoundID:      createdRound.ID,
				GroupNumber:  i + 1,
				StartingHole: 1,
			}
			if g.TeeTime != nil && *g.TeeTime != "" {
				var parsedTime time.Time
				var parseErr error
				parsedTime, parseErr = time.Parse("15:04", *g.TeeTime)
				if parseErr != nil {
					parsedTime, parseErr = time.Parse("3:04 PM", *g.TeeTime)
				}
				// Silently ignore unparseable tee times — the organizer can update later.
				if parseErr == nil {
					t := time.Date(
						scheduledDate.Year(), scheduledDate.Month(), scheduledDate.Day(),
						parsedTime.Hour(), parsedTime.Minute(), 0, 0, time.UTC,
					)
					group.TeeTime = &t
				}
			}
			if err := tx.Create(&group).Error; err != nil {
				return fmt.Errorf("create group %d: %w", i+1, err)
			}
		}
		return nil
	})

	if txErr != nil {
		// Let ValidationError and sentinel not-found errors surface as-is.
		var ve *ValidationError
		if errors.As(txErr, &ve) ||
			errors.Is(txErr, ErrCourseNotFound) ||
			errors.Is(txErr, ErrTeeNotFound) {
			return ScheduleRoundResult{}, txErr
		}
		return ScheduleRoundResult{}, fmt.Errorf("schedule round: %w", txErr)
	}

	return ScheduleRoundResult{
		Round:      createdRound,
		CourseName: courseName,
		GroupCount: len(groupInputs),
	}, nil
}

// Update applies a partial patch to a round. Caller must be an organizer.
func (s *RoundService) Update(ctx context.Context, roundID, callerID uuid.UUID, callerRole string, in UpdateRoundInput) (RoundUpdateResult, error) {
	// Validate before DB load so Tier 1 handler tests work without a real DB.
	if in.Name != nil && *in.Name == "" {
		return RoundUpdateResult{}, &ValidationError{Field: "name", Message: "name cannot be empty"}
	}
	if in.ScheduledDate != nil && *in.ScheduledDate == "" {
		return RoundUpdateResult{}, &ValidationError{Field: colScheduledDate, Message: "scheduled_date cannot be empty"}
	}
	if in.CourseID != nil && in.DefaultTeeID == nil {
		return RoundUpdateResult{}, &ValidationError{Field: colDefaultTeeID, Message: "default_tee_id is required when course_id is provided"}
	}
	if in.Status != nil {
		switch models.RoundStatus(*in.Status) {
		case models.RoundStatusScheduled, models.RoundStatusActive, models.RoundStatusCompleted:
			// valid
		default:
			return RoundUpdateResult{}, &ValidationError{Field: "status", Message: "status must be 'scheduled', 'active', or 'completed'"}
		}
	}

	isOrg, err := s.IsRoundOrganizer(ctx, roundID, callerID, callerRole)
	if errors.Is(err, ErrRoundNotFound) {
		return RoundUpdateResult{}, ErrRoundNotFound
	}
	if err != nil {
		return RoundUpdateResult{}, err
	}
	if !isOrg {
		return RoundUpdateResult{}, ErrRoundForbidden
	}

	var round models.Round
	if err := s.DB.WithContext(ctx).Preload("Course").First(&round, "id = ?", roundID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return RoundUpdateResult{}, ErrRoundNotFound
		}
		return RoundUpdateResult{}, fmt.Errorf("load round: %w", err)
	}

	if in.Name != nil {
		round.Name = *in.Name
	}
	if in.ScheduledDate != nil {
		parsed, err := time.Parse("2006-01-02", *in.ScheduledDate)
		if err != nil {
			return RoundUpdateResult{}, &ValidationError{Field: colScheduledDate, Message: "scheduled_date must be YYYY-MM-DD"}
		}
		round.ScheduledDate = parsed
	}
	if in.ScoringFormat != nil && *in.ScoringFormat != "" {
		round.ScoringFormat = models.ScoringFormat(*in.ScoringFormat)
	}
	if in.Status != nil {
		round.Status = models.RoundStatus(*in.Status)
	}

	if in.CourseID != nil {
		courseUUID, err := uuid.Parse(*in.CourseID)
		if err != nil {
			return RoundUpdateResult{}, &ValidationError{Field: "course_id", Message: "invalid course_id"}
		}
		teeUUID, err := uuid.Parse(*in.DefaultTeeID)
		if err != nil {
			return RoundUpdateResult{}, &ValidationError{Field: colDefaultTeeID, Message: "invalid default_tee_id"}
		}
		var course models.Course
		if err := s.DB.WithContext(ctx).First(&course, "id = ?", courseUUID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return RoundUpdateResult{}, ErrCourseNotFound
			}
			return RoundUpdateResult{}, fmt.Errorf("load course: %w", err)
		}
		var tee models.Tee
		if err := s.DB.WithContext(ctx).First(&tee, "id = ? AND course_id = ?", teeUUID, courseUUID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return RoundUpdateResult{}, ErrTeeNotFound
			}
			return RoundUpdateResult{}, fmt.Errorf("load tee: %w", err)
		}
		round.CourseID = courseUUID
		round.DefaultTeeID = teeUUID
	} else if in.CourseName != nil && *in.CourseName != "" {
		// Legacy find-or-create by name.
		var course models.Course
		if err := s.DB.WithContext(ctx).Where("name ILIKE ?", *in.CourseName).First(&course).Error; err != nil {
			course = models.Course{Name: *in.CourseName, HoleCount: 18}
			if err := s.DB.WithContext(ctx).Create(&course).Error; err != nil {
				return RoundUpdateResult{}, fmt.Errorf("create course: %w", err)
			}
			defaultTee := models.Tee{
				CourseID:     course.ID,
				Name:         "Default",
				Gender:       models.TeeGenderUnisex,
				CourseRating: 72.0,
				SlopeRating:  113,
				Par:          72,
			}
			if err := s.DB.WithContext(ctx).Create(&defaultTee).Error; err != nil {
				return RoundUpdateResult{}, fmt.Errorf("create default tee: %w", err)
			}
			round.CourseID = course.ID
			round.DefaultTeeID = defaultTee.ID
		} else {
			round.CourseID = course.ID
			var tee models.Tee
			if err := s.DB.WithContext(ctx).Where("course_id = ?", course.ID).First(&tee).Error; err != nil {
				tee = models.Tee{
					CourseID:     course.ID,
					Name:         "Default",
					Gender:       models.TeeGenderUnisex,
					CourseRating: 72.0,
					SlopeRating:  113,
					Par:          72,
				}
				if err := s.DB.WithContext(ctx).Create(&tee).Error; err != nil {
					return RoundUpdateResult{}, fmt.Errorf("create default tee: %w", err)
				}
			}
			round.DefaultTeeID = tee.ID
		}
	}

	if err := s.DB.WithContext(ctx).Save(&round).Error; err != nil {
		return RoundUpdateResult{}, fmt.Errorf("save round: %w", err)
	}

	// Reload for the fresh course name after a potential course change.
	s.DB.WithContext(ctx).Preload("Course").First(&round, "id = ?", roundID)
	return RoundUpdateResult{Round: round, CourseName: round.Course.Name}, nil
}

// Delete permanently removes a round. ON DELETE CASCADE removes groups and players.
// Caller must be an organizer.
func (s *RoundService) Delete(ctx context.Context, roundID, callerID uuid.UUID, callerRole string) error {
	isOrg, err := s.IsRoundOrganizer(ctx, roundID, callerID, callerRole)
	if errors.Is(err, ErrRoundNotFound) {
		return ErrRoundNotFound
	}
	if err != nil {
		return err
	}
	if !isOrg {
		return ErrRoundForbidden
	}

	if err := s.DB.WithContext(ctx).Delete(&models.Round{}, "id = ?", roundID).Error; err != nil {
		return fmt.Errorf("delete round: %w", err)
	}
	return nil
}

// CreateGroup creates a new empty tee-time group numbered one higher than the
// current maximum. Organizer-only.
func (s *RoundService) CreateGroup(ctx context.Context, roundID, callerID uuid.UUID, callerRole string) (GroupMutationResult, error) {
	isOrg, err := s.IsRoundOrganizer(ctx, roundID, callerID, callerRole)
	if errors.Is(err, ErrRoundNotFound) {
		return GroupMutationResult{}, ErrRoundNotFound
	}
	if err != nil {
		return GroupMutationResult{}, err
	}
	if !isOrg {
		return GroupMutationResult{}, ErrRoundForbidden
	}

	var maxGroupNum int
	s.DB.WithContext(ctx).Model(&models.Group{}).
		Where("round_id = ?", roundID).
		Select("COALESCE(MAX(group_number), 0)").
		Scan(&maxGroupNum)

	group := models.Group{
		RoundID:      roundID,
		GroupNumber:  maxGroupNum + 1,
		StartingHole: 1,
	}
	if err := s.DB.WithContext(ctx).Create(&group).Error; err != nil {
		return GroupMutationResult{}, fmt.Errorf("create group: %w", err)
	}

	players, err := s.loadGroupPlayers(ctx, group.ID)
	if err != nil {
		return GroupMutationResult{}, err
	}
	return GroupMutationResult{Group: group, Players: players}, nil
}

// UpdateGroup applies a partial patch to a group (name and/or tee time).
// Organizer-only.
func (s *RoundService) UpdateGroup(ctx context.Context, roundID, groupID, callerID uuid.UUID, callerRole string, in UpdateGroupInput) (GroupMutationResult, error) {
	// Validate tee time format before touching the DB so Tier 1 tests catch it.
	if in.TeeTime != nil && *in.TeeTime != "" {
		_, err1 := time.Parse("15:04", *in.TeeTime)
		_, err2 := time.Parse("3:04 PM", *in.TeeTime)
		if err1 != nil && err2 != nil {
			return GroupMutationResult{}, &ValidationError{Field: "tee_time", Message: "tee_time must be HH:MM or H:MM AM/PM"}
		}
	}

	isOrg, err := s.IsRoundOrganizer(ctx, roundID, callerID, callerRole)
	if errors.Is(err, ErrRoundNotFound) {
		return GroupMutationResult{}, ErrRoundNotFound
	}
	if err != nil {
		return GroupMutationResult{}, err
	}
	if !isOrg {
		return GroupMutationResult{}, ErrRoundForbidden
	}

	var group models.Group
	if err := s.DB.WithContext(ctx).First(&group, "id = ? AND round_id = ?", groupID, roundID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return GroupMutationResult{}, ErrGroupNotFound
		}
		return GroupMutationResult{}, fmt.Errorf("load group: %w", err)
	}

	if in.Name != nil {
		if *in.Name == "" {
			group.Name = nil
		} else {
			group.Name = in.Name
		}
	}
	if in.TeeTime != nil {
		if *in.TeeTime == "" {
			group.TeeTime = nil
		} else {
			// Both parse formats already validated above.
			parsedTime, err := time.Parse("15:04", *in.TeeTime)
			if err != nil {
				parsedTime, _ = time.Parse("3:04 PM", *in.TeeTime)
			}
			// Store on zero date — only the time component is meaningful here.
			t := time.Date(0, 1, 1, parsedTime.Hour(), parsedTime.Minute(), 0, 0, time.UTC)
			group.TeeTime = &t
		}
	}

	if err := s.DB.WithContext(ctx).Save(&group).Error; err != nil {
		return GroupMutationResult{}, fmt.Errorf("save group: %w", err)
	}

	players, err := s.loadGroupPlayers(ctx, group.ID)
	if err != nil {
		return GroupMutationResult{}, err
	}
	return GroupMutationResult{Group: group, Players: players}, nil
}

// DeleteGroup removes a tee-time group. group_players cascade automatically;
// round_players are intentionally kept so players remain registered and can be
// reassigned. Organizer-only.
func (s *RoundService) DeleteGroup(ctx context.Context, roundID, groupID, callerID uuid.UUID, callerRole string) error {
	isOrg, err := s.IsRoundOrganizer(ctx, roundID, callerID, callerRole)
	if errors.Is(err, ErrRoundNotFound) {
		return ErrRoundNotFound
	}
	if err != nil {
		return err
	}
	if !isOrg {
		return ErrRoundForbidden
	}

	var group models.Group
	if err := s.DB.WithContext(ctx).First(&group, "id = ? AND round_id = ?", groupID, roundID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrGroupNotFound
		}
		return fmt.Errorf("load group: %w", err)
	}

	if err := s.DB.WithContext(ctx).Delete(&group).Error; err != nil {
		return fmt.Errorf("delete group: %w", err)
	}
	return nil
}

// AddGroupMember adds a player to a tee-time group, creating a RoundPlayer if
// none exists. Enforces 4-player max and prevents duplicate group assignment.
// For event-linked rounds the target must be an event member.
// For eventless rounds any user may be added (subject to organizer permission).
// Organizer-only.
func (s *RoundService) AddGroupMember(ctx context.Context, roundID, groupID, callerID, targetUserID uuid.UUID, callerRole string) (GroupMutationResult, error) {
	isOrg, err := s.IsRoundOrganizer(ctx, roundID, callerID, callerRole)
	if errors.Is(err, ErrRoundNotFound) {
		return GroupMutationResult{}, ErrRoundNotFound
	}
	if err != nil {
		return GroupMutationResult{}, err
	}
	if !isOrg {
		return GroupMutationResult{}, ErrRoundForbidden
	}

	// Load round to determine event-linked vs eventless.
	var round models.Round
	if err := s.DB.WithContext(ctx).Select("id, event_id").First(&round, "id = ?", roundID).Error; err != nil {
		return GroupMutationResult{}, fmt.Errorf("load round: %w", err)
	}

	var group models.Group
	if err := s.DB.WithContext(ctx).First(&group, "id = ? AND round_id = ?", groupID, roundID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return GroupMutationResult{}, ErrGroupNotFound
		}
		return GroupMutationResult{}, fmt.Errorf("load group: %w", err)
	}

	var currentCount int64
	s.DB.WithContext(ctx).Model(&models.GroupPlayer{}).Where("group_id = ?", groupID).Count(&currentCount)
	if currentCount >= 4 {
		return GroupMutationResult{}, ErrGroupFull
	}

	// Find-or-create RoundPlayer — a player has exactly one RoundPlayer record per round.
	var roundPlayer models.RoundPlayer
	if round.EventID != nil {
		// Event-linked round: target must be an event member.
		var eventPlayer models.EventPlayer
		if err := s.DB.WithContext(ctx).Where("event_id = ? AND user_id = ?", *round.EventID, targetUserID).
			First(&eventPlayer).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return GroupMutationResult{}, ErrPlayerNotEventMember
			}
			return GroupMutationResult{}, fmt.Errorf("load event player: %w", err)
		}
		epID := eventPlayer.ID
		if err := s.DB.WithContext(ctx).Where("round_id = ? AND event_player_id = ?", roundID, epID).
			First(&roundPlayer).Error; err != nil {
			roundPlayer = models.RoundPlayer{
				RoundID:       roundID,
				UserID:        targetUserID,
				EventPlayerID: &epID,
				Status:        models.RoundPlayerStatusRegistered,
			}
			if err := s.DB.WithContext(ctx).Create(&roundPlayer).Error; err != nil {
				return GroupMutationResult{}, fmt.Errorf("create round player: %w", err)
			}
		}
	} else {
		// Eventless round: create RoundPlayer by user_id directly.
		if err := s.DB.WithContext(ctx).Where("round_id = ? AND user_id = ?", roundID, targetUserID).
			First(&roundPlayer).Error; err != nil {
			roundPlayer = models.RoundPlayer{
				RoundID: roundID,
				UserID:  targetUserID,
				Status:  models.RoundPlayerStatusRegistered,
			}
			if err := s.DB.WithContext(ctx).Create(&roundPlayer).Error; err != nil {
				return GroupMutationResult{}, fmt.Errorf("create round player: %w", err)
			}
		}
	}

	// Prevent a player from being in two groups for the same round.
	var existing models.GroupPlayer
	alreadyAssigned := s.DB.WithContext(ctx).
		Joins("JOIN groups g ON g.id = group_players.group_id").
		Where("group_players.round_player_id = ? AND g.round_id = ?", roundPlayer.ID, roundID).
		First(&existing).Error == nil
	if alreadyAssigned {
		return GroupMutationResult{}, ErrPlayerAlreadyInGroup
	}

	gp := models.GroupPlayer{GroupID: groupID, RoundPlayerID: roundPlayer.ID}
	if err := s.DB.WithContext(ctx).Create(&gp).Error; err != nil {
		return GroupMutationResult{}, fmt.Errorf("add group player: %w", err)
	}

	players, err := s.loadGroupPlayers(ctx, group.ID)
	if err != nil {
		return GroupMutationResult{}, err
	}
	return GroupMutationResult{Group: group, Players: players}, nil
}

// RemoveGroupMember removes a player from a group by deleting their RoundPlayer.
// The GroupPlayer join row is removed automatically via ON DELETE CASCADE.
// Organizer-only.
func (s *RoundService) RemoveGroupMember(ctx context.Context, roundID, groupID, callerID, targetUserID uuid.UUID, callerRole string) error {
	isOrg, err := s.IsRoundOrganizer(ctx, roundID, callerID, callerRole)
	if errors.Is(err, ErrRoundNotFound) {
		return ErrRoundNotFound
	}
	if err != nil {
		return err
	}
	if !isOrg {
		return ErrRoundForbidden
	}

	// Load round to determine event-linked vs eventless.
	var round models.Round
	if err := s.DB.WithContext(ctx).Select("id, event_id").First(&round, "id = ?", roundID).Error; err != nil {
		return fmt.Errorf("load round: %w", err)
	}

	var group models.Group
	if err := s.DB.WithContext(ctx).First(&group, "id = ? AND round_id = ?", groupID, roundID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrGroupNotFound
		}
		return fmt.Errorf("load group: %w", err)
	}

	// Look up RoundPlayer via event_player (event rounds) or user_id directly (eventless).
	var roundPlayer models.RoundPlayer
	if round.EventID != nil {
		var eventPlayer models.EventPlayer
		if err := s.DB.WithContext(ctx).Where("event_id = ? AND user_id = ?", *round.EventID, targetUserID).
			First(&eventPlayer).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlayerNotEventMember
			}
			return fmt.Errorf("load event player: %w", err)
		}
		if err := s.DB.WithContext(ctx).Where("round_id = ? AND event_player_id = ?", roundID, eventPlayer.ID).
			First(&roundPlayer).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlayerNotInRound
			}
			return fmt.Errorf("load round player: %w", err)
		}
	} else {
		if err := s.DB.WithContext(ctx).Where("round_id = ? AND user_id = ?", roundID, targetUserID).
			First(&roundPlayer).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlayerNotInRound
			}
			return fmt.Errorf("load round player: %w", err)
		}
	}

	// Deleting RoundPlayer cascades to GroupPlayer via ON DELETE CASCADE.
	if err := s.DB.WithContext(ctx).Delete(&roundPlayer).Error; err != nil {
		return fmt.Errorf("delete round player: %w", err)
	}
	return nil
}

// ─── Eventless rounds ─────────────────────────────────────────────────────────

// CreateEventlessRoundInput is the payload for CreateEventlessRound.
// Either CourseID (UUID string) or CourseName must be provided.
// DefaultTeeID is optional; if omitted the first tee for the course is used.
type CreateEventlessRoundInput struct {
	Name              string
	ScheduledDate     string // "YYYY-MM-DD" required
	ScoringFormat     *string
	CourseID          *string
	DefaultTeeID      *string
	CourseName        string
	NineHoleSelection *string // "front" or "back"; nil = full round
}

// CreateEventlessRound creates a standalone round with no event association.
// The caller is automatically added to Group 1. Uses the same course-lookup
// logic as Schedule.
func (s *RoundService) CreateEventlessRound(ctx context.Context, callerID uuid.UUID, in CreateEventlessRoundInput) (ScheduleRoundResult, error) {
	if in.CourseID == nil && in.CourseName == "" {
		return ScheduleRoundResult{}, &ValidationError{Field: "course", Message: "course_id or course_name is required"}
	}
	if in.CourseID != nil && in.DefaultTeeID == nil {
		return ScheduleRoundResult{}, &ValidationError{Field: colDefaultTeeID, Message: "default_tee_id is required when course_id is provided"}
	}
	if in.ScheduledDate == "" {
		return ScheduleRoundResult{}, &ValidationError{Field: colScheduledDate, Message: "scheduled_date is required"}
	}
	scheduledDate, err := time.Parse("2006-01-02", in.ScheduledDate)
	if err != nil {
		return ScheduleRoundResult{}, &ValidationError{Field: colScheduledDate, Message: "scheduled_date must be YYYY-MM-DD"}
	}
	if in.NineHoleSelection != nil {
		sel := *in.NineHoleSelection
		if sel != nineHoleFront && sel != nineHoleBack {
			return ScheduleRoundResult{}, &ValidationError{Field: colNineHoleSelection, Message: `nine_hole_selection must be "front" or "back"`}
		}
	}

	scoringFormat := models.ScoringFormatStroke
	if in.ScoringFormat != nil && *in.ScoringFormat != "" {
		scoringFormat = models.ScoringFormat(*in.ScoringFormat)
	}

	roundName := in.Name
	if roundName == "" {
		roundName = "Round"
	}

	var createdRound models.Round
	var courseName string

	txErr := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var course models.Course
		var teeID uuid.UUID

		if in.CourseID != nil {
			courseUUID, err := uuid.Parse(*in.CourseID)
			if err != nil {
				return &ValidationError{Field: "course_id", Message: "invalid course_id"}
			}
			if err := tx.First(&course, "id = ?", courseUUID).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return ErrCourseNotFound
				}
				return fmt.Errorf("load course: %w", err)
			}
			teeUUID, err := uuid.Parse(*in.DefaultTeeID)
			if err != nil {
				return &ValidationError{Field: colDefaultTeeID, Message: "invalid default_tee_id"}
			}
			var tee models.Tee
			if err := tx.First(&tee, "id = ? AND course_id = ?", teeUUID, courseUUID).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return ErrTeeNotFound
				}
				return fmt.Errorf("load tee: %w", err)
			}
			teeID = teeUUID
		} else {
			if err := tx.Where("name ILIKE ?", in.CourseName).First(&course).Error; err != nil {
				course = models.Course{Name: in.CourseName, HoleCount: 18}
				if err := tx.Create(&course).Error; err != nil {
					return fmt.Errorf("create course: %w", err)
				}
				defaultTee := models.Tee{
					CourseID:     course.ID,
					Name:         "Default",
					Gender:       models.TeeGenderUnisex,
					CourseRating: 72.0,
					SlopeRating:  113,
					Par:          72,
				}
				if err := tx.Create(&defaultTee).Error; err != nil {
					return fmt.Errorf("create default tee: %w", err)
				}
				teeID = defaultTee.ID
			} else {
				var tee models.Tee
				if err := tx.Where("course_id = ?", course.ID).First(&tee).Error; err != nil {
					tee = models.Tee{
						CourseID:     course.ID,
						Name:         "Default",
						Gender:       models.TeeGenderUnisex,
						CourseRating: 72.0,
						SlopeRating:  113,
						Par:          72,
					}
					if err := tx.Create(&tee).Error; err != nil {
						return fmt.Errorf("create default tee: %w", err)
					}
				}
				teeID = tee.ID
			}
		}
		courseName = course.Name

		createdRound = models.Round{
			EventID:           nil,
			CreatedBy:         &callerID,
			CourseID:          course.ID,
			DefaultTeeID:      teeID,
			Name:              roundName,
			RoundNumber:       1,
			ScheduledDate:     scheduledDate,
			Status:            models.RoundStatusScheduled,
			ScoringFormat:     scoringFormat,
			NineHoleSelection: in.NineHoleSelection,
		}
		if err := tx.Create(&createdRound).Error; err != nil {
			return fmt.Errorf("create round: %w", err)
		}

		// Auto-create Group 1 and add the creator to it.
		group := models.Group{
			RoundID:      createdRound.ID,
			GroupNumber:  1,
			StartingHole: 1,
		}
		if err := tx.Create(&group).Error; err != nil {
			return fmt.Errorf("create group: %w", err)
		}

		rp := models.RoundPlayer{
			RoundID: createdRound.ID,
			UserID:  callerID,
			Status:  models.RoundPlayerStatusRegistered,
		}
		if err := tx.Create(&rp).Error; err != nil {
			return fmt.Errorf("create round player: %w", err)
		}

		gp := models.GroupPlayer{GroupID: group.ID, RoundPlayerID: rp.ID}
		if err := tx.Create(&gp).Error; err != nil {
			return fmt.Errorf("create group player: %w", err)
		}

		return nil
	})

	if txErr != nil {
		var ve *ValidationError
		if errors.As(txErr, &ve) ||
			errors.Is(txErr, ErrCourseNotFound) ||
			errors.Is(txErr, ErrTeeNotFound) {
			return ScheduleRoundResult{}, txErr
		}
		return ScheduleRoundResult{}, fmt.Errorf("create eventless round: %w", txErr)
	}

	return ScheduleRoundResult{
		Round:      createdRound,
		CourseName: courseName,
		GroupCount: 1,
	}, nil
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

// loadGroupPlayers fetches the current players for a group via a raw join.
// Uses rp.user_id directly — works for both event-linked and eventless rounds
// after migration 000020 backfilled user_id on all existing round_players.
func (s *RoundService) loadGroupPlayers(ctx context.Context, groupID uuid.UUID) ([]GroupPlayerResult, error) {
	type playerRow struct {
		RoundPlayerID string
		UserID        string
		DisplayName   string
		Email         string
		AvatarURL     *string
	}
	var rows []playerRow
	if err := s.DB.WithContext(ctx).Table("group_players gp").
		Select("gp.round_player_id, u.id as user_id, u.display_name, u.email, u.avatar_url").
		Joins("JOIN round_players rp ON rp.id = gp.round_player_id").
		Joins("JOIN users u ON u.id = rp.user_id").
		Where("gp.group_id = ?", groupID).
		Scan(&rows).Error; err != nil {
		return nil, fmt.Errorf("load group players: %w", err)
	}

	out := make([]GroupPlayerResult, len(rows))
	for i, row := range rows {
		out[i] = GroupPlayerResult(row)
	}
	return out, nil
}
