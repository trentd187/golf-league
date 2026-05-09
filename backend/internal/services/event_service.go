// services/event_service.go
// EventService owns all business logic for events, event members, and the
// list of rounds within an event. Handlers in internal/handlers/events.go
// parse HTTP, call methods here, and translate the (value, error) results
// into HTTP status codes via writeEventError.
//
// Permission model:
//   - "admin" global role → can manage ANY event.
//   - Everyone else → must hold the "organizer" event_player role for THIS
//     event to mutate it. IsOrganizer is the canonical check.
//   - Read methods either require admin OR membership, depending on the
//     route (List filters by membership; Get returns 403 for non-members).
//
// IsOrganizer is exposed for use by RoundsService and ScoreService in later
// PRs — they need the same check at round / score boundaries.
package services

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/trentd187/golf-league/internal/models"
	"gorm.io/gorm"
)

// ─── Sentinel errors ───────────────────────────────────────────────────────────

var (
	// ErrEventNotFound — no event with the requested ID.
	ErrEventNotFound = errors.New("event not found")
	// ErrEventForbidden — caller is not authorized for the requested mutation
	// (not an organizer of this event AND not a global admin).
	ErrEventForbidden = errors.New("not authorized for this event")
	// ErrEventNotMember — caller is not admin and not a member; cannot view detail.
	ErrEventNotMember = errors.New("not a member of this event")
	// ErrUserNotFound — looking up a user (e.g. by AddMember target) missed.
	ErrUserNotFound = errors.New("user not found")
	// ErrMemberAlreadyExists — AddMember tried to add a user who is already a member.
	ErrMemberAlreadyExists = errors.New("user is already a member")
	// ErrMemberNotFound — RemoveMember target is not on the event_players list.
	ErrMemberNotFound = errors.New("member not found")
	// ErrLastOrganizer — cannot remove the last remaining organizer.
	ErrLastOrganizer = errors.New("cannot remove the last organizer; promote another member first")
)

// ─── Inputs and DTOs ───────────────────────────────────────────────────────────

// CreateEventInput is the validated payload accepted by Create.
// Date strings are "YYYY-MM-DD"; the service parses them.
type CreateEventInput struct {
	Name              string
	Description       *string
	EventType         string  // "league", "tournament", "casual"
	StartDate         *string // optional, "" or nil = no start date
	EndDate           *string
	HandicapAllowance *float64 // 0..100; nil = full handicap
	CreatedBy         uuid.UUID
}

// UpdateEventInput is the optional-fields payload for Update.
//
// Field semantics:
//   - nil pointer       → leave alone
//   - non-nil pointer   → apply that value
//   - StartDate/EndDate: nil = leave alone; pointer to "" = clear; pointer to
//     "YYYY-MM-DD" = set.
type UpdateEventInput struct {
	Name              *string
	Description       *string
	StartDate         *string
	EndDate           *string
	Status            *string  // "active", "completed", "cancelled"
	HandicapAllowance *float64 // 0..100
}

// ListEventsFilters scopes a List query to a single user's view.
type ListEventsFilters struct {
	UserID   uuid.UUID
	UserRole string // "admin" returns everything; everyone else only their events
	Type     string // optional EventType filter
}

// EventListItem is one row in a List result: the event + its creator + member count.
type EventListItem struct {
	Event       models.Event
	Creator     models.User
	MemberCount int64
}

// EventDetail is what Get returns: the event + creator + members.
type EventDetail struct {
	Event       models.Event
	Creator     models.User
	Members     []EventMemberItem
	MemberCount int64
}

// EventMemberItem is one row in a members list: the EventPlayer + the joined User.
type EventMemberItem struct {
	Player models.EventPlayer
	User   models.User
}

// UpdateEventResult is what Update returns: the saved event row + a flag
// telling the handler whether to fire RecalculateEventScores.
type UpdateEventResult struct {
	Event            models.Event
	Creator          models.User
	MemberCount      int64
	AllowanceChanged bool
	StatusChanged    bool
}

// RoundsListItem is one row in GetRounds: the round + its course name + group count.
type RoundsListItem struct {
	Round      models.Round
	CourseName string
	GroupCount int
}

// ─── Constructor ───────────────────────────────────────────────────────────────

// EventService bundles a DB handle. Construct one in main.go and inject into
// every events handler factory.
type EventService struct {
	DB *gorm.DB
}

// NewEventService builds an EventService.
func NewEventService(db *gorm.DB) *EventService {
	return &EventService{DB: db}
}

// ─── Permission check ──────────────────────────────────────────────────────────

// IsOrganizer reports whether userID is allowed to mutate eventID.
//
//   - "admin" global role → always true.
//   - Anyone else → must hold the "organizer" event_player role for this event.
//
// Exposed (rather than kept private) because RoundsService and ScoreService
// need the same check at their own boundaries.
func (s *EventService) IsOrganizer(ctx context.Context, eventID, userID uuid.UUID, userRole string) (bool, error) {
	if userRole == "admin" {
		return true, nil
	}
	var player models.EventPlayer
	err := s.DB.WithContext(ctx).
		Where("event_id = ? AND user_id = ?", eventID, userID).
		First(&player).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("check organizer: %w", err)
	}
	return player.Role == models.EventPlayerRoleOrganizer, nil
}

// ─── Read methods ──────────────────────────────────────────────────────────────

// List returns every event visible to the requesting user.
//
//   - Admins see all events.
//   - Everyone else sees only events they are an event_player of.
//
// Optional Type filter scopes by event_type (league/tournament/casual).
func (s *EventService) List(ctx context.Context, f ListEventsFilters) ([]EventListItem, error) {
	q := s.DB.WithContext(ctx).Preload("Creator").Model(&models.Event{})
	if f.Type != "" {
		q = q.Where("event_type = ?", f.Type)
	}
	if f.UserRole != "admin" {
		q = q.Joins("JOIN event_players ON event_players.event_id = events.id").
			Where("event_players.user_id = ?", f.UserID)
	}

	var events []models.Event
	if err := q.Find(&events).Error; err != nil {
		return nil, fmt.Errorf("list events: %w", err)
	}

	if len(events) == 0 {
		return []EventListItem{}, nil
	}

	// Member counts in one batched query to avoid N+1.
	ids := make([]uuid.UUID, len(events))
	for i, e := range events {
		ids[i] = e.ID
	}
	type countRow struct {
		EventID string
		Count   int64
	}
	var rows []countRow
	if err := s.DB.WithContext(ctx).Model(&models.EventPlayer{}).
		Select("event_id, COUNT(*) as count").
		Where("event_id IN ?", ids).
		Group("event_id").
		Scan(&rows).Error; err != nil {
		return nil, fmt.Errorf("count members: %w", err)
	}
	counts := make(map[string]int64, len(rows))
	for _, r := range rows {
		counts[r.EventID] = r.Count
	}

	out := make([]EventListItem, len(events))
	for i, e := range events {
		out[i] = EventListItem{
			Event:       e,
			Creator:     e.Creator,
			MemberCount: counts[e.ID.String()],
		}
	}
	return out, nil
}

// Get returns the full detail for a single event.
//
// Non-admins must be members; otherwise ErrEventNotMember.
func (s *EventService) Get(ctx context.Context, eventID, requesterID uuid.UUID, requesterRole string) (EventDetail, error) {
	var event models.Event
	if err := s.DB.WithContext(ctx).Preload("Creator").First(&event, "id = ?", eventID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return EventDetail{}, ErrEventNotFound
		}
		return EventDetail{}, fmt.Errorf("load event: %w", err)
	}

	if requesterRole != "admin" {
		var count int64
		if err := s.DB.WithContext(ctx).Model(&models.EventPlayer{}).
			Where("event_id = ? AND user_id = ?", eventID, requesterID).
			Count(&count).Error; err != nil {
			return EventDetail{}, fmt.Errorf("check membership: %w", err)
		}
		if count == 0 {
			return EventDetail{}, ErrEventNotMember
		}
	}

	var players []models.EventPlayer
	if err := s.DB.WithContext(ctx).Preload("User").
		Where("event_id = ?", eventID).Find(&players).Error; err != nil {
		return EventDetail{}, fmt.Errorf("load members: %w", err)
	}

	members := make([]EventMemberItem, len(players))
	for i, p := range players {
		members[i] = EventMemberItem{Player: p, User: p.User}
	}

	return EventDetail{
		Event:       event,
		Creator:     event.Creator,
		Members:     members,
		MemberCount: int64(len(members)),
	}, nil
}

// GetMembers returns the members list for an event. No membership check —
// the route is open to any authenticated user, matching legacy behavior.
func (s *EventService) GetMembers(ctx context.Context, eventID uuid.UUID) ([]EventMemberItem, error) {
	var players []models.EventPlayer
	if err := s.DB.WithContext(ctx).Preload("User").
		Where("event_id = ?", eventID).Find(&players).Error; err != nil {
		return nil, fmt.Errorf("load members: %w", err)
	}
	out := make([]EventMemberItem, len(players))
	for i, p := range players {
		out[i] = EventMemberItem{Player: p, User: p.User}
	}
	return out, nil
}

// GetRounds returns the rounds belonging to an event, sorted by round_number.
// Course is preloaded so the handler can return its name; group counts come
// from one batched query.
func (s *EventService) GetRounds(ctx context.Context, eventID uuid.UUID) ([]RoundsListItem, error) {
	var rounds []models.Round
	if err := s.DB.WithContext(ctx).Preload("Course").
		Where("event_id = ?", eventID).
		Order("round_number ASC").
		Find(&rounds).Error; err != nil {
		return nil, fmt.Errorf("load rounds: %w", err)
	}

	if len(rounds) == 0 {
		return []RoundsListItem{}, nil
	}

	ids := make([]uuid.UUID, len(rounds))
	for i, r := range rounds {
		ids[i] = r.ID
	}
	type countRow struct {
		RoundID string
		Count   int
	}
	var rows []countRow
	if err := s.DB.WithContext(ctx).Model(&models.Group{}).
		Select("round_id, COUNT(*) as count").
		Where("round_id IN ?", ids).
		Group("round_id").
		Scan(&rows).Error; err != nil {
		return nil, fmt.Errorf("count groups: %w", err)
	}
	counts := make(map[string]int, len(rows))
	for _, row := range rows {
		counts[row.RoundID] = row.Count
	}

	out := make([]RoundsListItem, len(rounds))
	for i, r := range rounds {
		out[i] = RoundsListItem{
			Round:      r,
			CourseName: r.Course.Name,
			GroupCount: counts[r.ID.String()],
		}
	}
	return out, nil
}

// ─── Mutations ─────────────────────────────────────────────────────────────────

// Create validates the input and creates an event in a single transaction
// that also auto-adds the creator as an organizer. If the organizer insert
// fails, the event row is rolled back so we never end up with a leaderless event.
func (s *EventService) Create(ctx context.Context, in CreateEventInput) (EventListItem, error) {
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		return EventListItem{}, &ValidationError{Field: "name", Message: "name is required"}
	}
	if !isValidEventType(in.EventType) {
		return EventListItem{}, &ValidationError{
			Field:   "event_type",
			Message: "event_type must be 'league', 'tournament', or 'casual'",
		}
	}
	startDate, err := parseEventDate(in.StartDate)
	if err != nil {
		return EventListItem{}, &ValidationError{Field: "start_date", Message: "start_date must be in YYYY-MM-DD format"}
	}
	endDate, err := parseEventDate(in.EndDate)
	if err != nil {
		return EventListItem{}, &ValidationError{Field: "end_date", Message: "end_date must be in YYYY-MM-DD format"}
	}
	if err := validateAllowance(in.HandicapAllowance); err != nil {
		return EventListItem{}, err
	}

	var created models.Event
	txErr := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		event := models.Event{
			Name:              in.Name,
			Description:       in.Description,
			EventType:         models.EventType(in.EventType),
			Status:            models.EventStatusActive, // "upcoming" was removed from the enum
			StartDate:         startDate,
			EndDate:           endDate,
			HandicapAllowance: in.HandicapAllowance,
			CreatedBy:         in.CreatedBy,
		}
		if err := tx.Create(&event).Error; err != nil {
			return fmt.Errorf("create event row: %w", err)
		}
		player := models.EventPlayer{
			EventID: event.ID,
			UserID:  in.CreatedBy,
			Role:    models.EventPlayerRoleOrganizer,
			Status:  models.EventPlayerStatusRegistered,
		}
		if err := tx.Create(&player).Error; err != nil {
			return fmt.Errorf("auto-add creator as organizer: %w", err)
		}
		created = event
		return nil
	})
	if txErr != nil {
		return EventListItem{}, fmt.Errorf("create event: %w", txErr)
	}

	var creator models.User
	if err := s.DB.WithContext(ctx).First(&creator, "id = ?", in.CreatedBy).Error; err != nil {
		// Non-fatal — fall back to the empty creator.
		creator = models.User{}
	}

	return EventListItem{
		Event:       created,
		Creator:     creator,
		MemberCount: 1,
	}, nil
}

// Update applies a partial patch to an event. Caller must have organizer role.
//
// Returns the saved event plus an AllowanceChanged flag — handlers use that
// to decide whether to call RecalculateEventScores.
func (s *EventService) Update(ctx context.Context, eventID, requesterID uuid.UUID, requesterRole string, in UpdateEventInput) (UpdateEventResult, error) {
	// Validate body BEFORE the DB load so Tier-1 tests can reach validation
	// without a real database (matches the legacy handler's order).
	if in.Name != nil && strings.TrimSpace(*in.Name) == "" {
		return UpdateEventResult{}, &ValidationError{Field: "name", Message: "name cannot be empty"}
	}
	if err := validateAllowance(in.HandicapAllowance); err != nil {
		return UpdateEventResult{}, err
	}

	var event models.Event
	if err := s.DB.WithContext(ctx).Preload("Creator").First(&event, "id = ?", eventID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return UpdateEventResult{}, ErrEventNotFound
		}
		return UpdateEventResult{}, fmt.Errorf("load event: %w", err)
	}

	authorized, err := s.IsOrganizer(ctx, eventID, requesterID, requesterRole)
	if err != nil {
		return UpdateEventResult{}, err
	}
	if !authorized {
		return UpdateEventResult{}, ErrEventForbidden
	}

	if in.Description != nil {
		event.Description = in.Description
	}
	if in.Name != nil {
		event.Name = *in.Name
	}
	if in.StartDate != nil {
		t, err := parseEventDate(in.StartDate)
		if err != nil {
			return UpdateEventResult{}, &ValidationError{Field: "start_date", Message: "start_date must be YYYY-MM-DD"}
		}
		event.StartDate = t
	}
	if in.EndDate != nil {
		t, err := parseEventDate(in.EndDate)
		if err != nil {
			return UpdateEventResult{}, &ValidationError{Field: "end_date", Message: "end_date must be YYYY-MM-DD"}
		}
		event.EndDate = t
	}
	statusChanged := false
	if in.Status != nil {
		switch *in.Status {
		case "active", "completed", "cancelled":
			if string(event.Status) != *in.Status {
				statusChanged = true
			}
			event.Status = models.EventStatus(*in.Status)
		default:
			return UpdateEventResult{}, &ValidationError{
				Field:   "status",
				Message: "status must be 'active', 'completed', or 'cancelled'",
			}
		}
	}
	allowanceChanged := in.HandicapAllowance != nil
	if allowanceChanged {
		event.HandicapAllowance = in.HandicapAllowance
	}

	if err := s.DB.WithContext(ctx).Save(&event).Error; err != nil {
		return UpdateEventResult{}, fmt.Errorf("save event: %w", err)
	}

	var memberCount int64
	if err := s.DB.WithContext(ctx).Model(&models.EventPlayer{}).
		Where("event_id = ?", event.ID).Count(&memberCount).Error; err != nil {
		return UpdateEventResult{}, fmt.Errorf("count members: %w", err)
	}

	return UpdateEventResult{
		Event:            event,
		Creator:          event.Creator,
		MemberCount:      memberCount,
		AllowanceChanged: allowanceChanged,
		StatusChanged:    statusChanged,
	}, nil
}

// Delete permanently removes an event. ON DELETE CASCADE removes child records.
// Caller must be an organizer of the event (or an admin).
func (s *EventService) Delete(ctx context.Context, eventID, requesterID uuid.UUID, requesterRole string) error {
	var event models.Event
	if err := s.DB.WithContext(ctx).First(&event, "id = ?", eventID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrEventNotFound
		}
		return fmt.Errorf("load event: %w", err)
	}
	authorized, err := s.IsOrganizer(ctx, eventID, requesterID, requesterRole)
	if err != nil {
		return err
	}
	if !authorized {
		return ErrEventForbidden
	}
	if err := s.DB.WithContext(ctx).Delete(&event).Error; err != nil {
		return fmt.Errorf("delete event: %w", err)
	}
	return nil
}

// AddMember adds a new player to an event. Caller must be organizer.
// New members are added with role=player and status=registered.
func (s *EventService) AddMember(ctx context.Context, eventID, requesterID uuid.UUID, requesterRole string, targetUserID uuid.UUID) (EventMemberItem, error) {
	authorized, err := s.IsOrganizer(ctx, eventID, requesterID, requesterRole)
	if err != nil {
		return EventMemberItem{}, err
	}
	if !authorized {
		return EventMemberItem{}, ErrEventForbidden
	}

	var target models.User
	if err := s.DB.WithContext(ctx).First(&target, "id = ?", targetUserID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return EventMemberItem{}, ErrUserNotFound
		}
		return EventMemberItem{}, fmt.Errorf("load target user: %w", err)
	}

	// Friendly duplicate-check; there's also a unique index on (event_id, user_id).
	var existing models.EventPlayer
	dupErr := s.DB.WithContext(ctx).
		Where("event_id = ? AND user_id = ?", eventID, targetUserID).
		First(&existing).Error
	if dupErr == nil {
		return EventMemberItem{}, ErrMemberAlreadyExists
	}
	if !errors.Is(dupErr, gorm.ErrRecordNotFound) {
		return EventMemberItem{}, fmt.Errorf("dup-check: %w", dupErr)
	}

	player := models.EventPlayer{
		EventID: eventID,
		UserID:  targetUserID,
		Role:    models.EventPlayerRolePlayer,
		Status:  models.EventPlayerStatusRegistered,
	}
	if err := s.DB.WithContext(ctx).Create(&player).Error; err != nil {
		return EventMemberItem{}, fmt.Errorf("create event_player: %w", err)
	}
	return EventMemberItem{Player: player, User: target}, nil
}

// RemoveMember removes a player from an event. Caller must be organizer.
// Refuses to remove the LAST organizer — every event must remain manageable.
func (s *EventService) RemoveMember(ctx context.Context, eventID, requesterID uuid.UUID, requesterRole string, targetUserID uuid.UUID) error {
	authorized, err := s.IsOrganizer(ctx, eventID, requesterID, requesterRole)
	if err != nil {
		return err
	}
	if !authorized {
		return ErrEventForbidden
	}

	var player models.EventPlayer
	err = s.DB.WithContext(ctx).
		Where("event_id = ? AND user_id = ?", eventID, targetUserID).
		First(&player).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrMemberNotFound
		}
		return fmt.Errorf("load member: %w", err)
	}

	if player.Role == models.EventPlayerRoleOrganizer {
		var organizerCount int64
		if err := s.DB.WithContext(ctx).Model(&models.EventPlayer{}).
			Where("event_id = ? AND role = ?", eventID, models.EventPlayerRoleOrganizer).
			Count(&organizerCount).Error; err != nil {
			return fmt.Errorf("count organizers: %w", err)
		}
		if organizerCount <= 1 {
			return ErrLastOrganizer
		}
	}

	if err := s.DB.WithContext(ctx).Delete(&player).Error; err != nil {
		return fmt.Errorf("delete event_player: %w", err)
	}
	return nil
}

// ─── Private helpers ───────────────────────────────────────────────────────────

func isValidEventType(t string) bool {
	switch t {
	case "league", "tournament", "casual":
		return true
	}
	return false
}

// parseEventDate converts "YYYY-MM-DD" to a *time.Time.
//
//	nil or "" → nil, nil  (means: leave alone / clear, depending on caller)
//	"YYYY-MM-DD" → parsed *time.Time, nil
//	anything else → nil, error
func parseEventDate(s *string) (*time.Time, error) {
	if s == nil || *s == "" {
		return nil, nil
	}
	t, err := time.Parse("2006-01-02", *s)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

func validateAllowance(allowance *float64) error {
	if allowance == nil {
		return nil
	}
	if *allowance < 0 || *allowance > 100 {
		return &ValidationError{
			Field:   "handicap_allowance",
			Message: "handicap_allowance must be between 0 and 100",
		}
	}
	return nil
}
