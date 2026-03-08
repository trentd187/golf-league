// Package services contains clients for external services used by the Golf League API.
// This file implements a client for GolfCourseAPI.com, a free API that provides
// course information including hole-by-hole par, yardage, and stroke indexes.
package services

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

const golfCourseAPIBase = "https://api.golfcourseapi.com/v1"

// GolfCourseAPIClient is a thin HTTP client for GolfCourseAPI.com.
// Create one at startup via NewGolfCourseAPIClient and inject it into handlers.
type GolfCourseAPIClient struct {
	apiKey string
	http   *http.Client // explicit timeout — never use http.DefaultClient for external calls
}

// NewGolfCourseAPIClient returns a configured client ready to use.
// apiKey is your GolfCourseAPI.com key (set in GOLF_COURSE_API_KEY env var).
func NewGolfCourseAPIClient(apiKey string) *GolfCourseAPIClient {
	return &GolfCourseAPIClient{
		apiKey: apiKey,
		http:   &http.Client{Timeout: 10 * time.Second},
	}
}

// ─── External data types ───────────────────────────────────────────────────────
// These structs model GolfCourseAPI.com's JSON response shapes.

// ExternalCourseSummary is the compact course record returned by the search endpoint.
// GolfCourseAPI.com returns "id" as a JSON number, so we use int here.
type ExternalCourseSummary struct {
	ID         int    `json:"id"`
	ClubName   string `json:"club_name"`
	CourseName string `json:"course_name"`
	City       string `json:"city"`
	State      string `json:"state_name"`
}

// ExternalTee describes one tee set from the external API.
type ExternalTee struct {
	TeeType      string         `json:"tee_type"` // e.g. "Blue", "White", "Red"
	Gender       string         `json:"gender"`   // "Male", "Female", or ""
	CourseRating float64        `json:"course_rating"`
	SlopeRating  int            `json:"slope_rating"`
	Par          int            `json:"par"`
	Holes        []ExternalHole `json:"holes"`
}

// ExternalHole describes one hole from the external API.
type ExternalHole struct {
	HoleNumber  int `json:"hole_number"`
	Par         int `json:"par"`
	StrokeIndex int `json:"handicap"` // GolfCourseAPI calls this "handicap"
	Yardage     int `json:"yardage"`
}

// ExternalCourseDetail is the full course record returned by the detail endpoint.
// GolfCourseAPI.com returns "id" as a JSON number, so we use int here.
type ExternalCourseDetail struct {
	ID         int           `json:"id"`
	ClubName   string        `json:"club_name"`
	CourseName string        `json:"course_name"`
	City       string        `json:"city"`
	State      string        `json:"state_name"`
	NumHoles   int           `json:"num_holes"`
	Tees       []ExternalTee `json:"tees"`
}

// IsConfigured reports whether an API key has been provided.
// Handlers call this before making any external API requests and return 503 if false,
// so the caller gets a clear error instead of a cryptic 401 from GolfCourseAPI.
func (c *GolfCourseAPIClient) IsConfigured() bool {
	return c.apiKey != ""
}

// ─── API methods ───────────────────────────────────────────────────────────────

// Search queries GolfCourseAPI for courses matching the given search term.
// The search term is matched against course name and club name.
func (c *GolfCourseAPIClient) Search(searchTerm string) ([]ExternalCourseSummary, error) {
	endpoint := fmt.Sprintf("%s/courses?search=%s", golfCourseAPIBase, url.QueryEscape(searchTerm))

	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Key "+c.apiKey)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API returned %d: %s", resp.StatusCode, string(body))
	}

	// GolfCourseAPI wraps results in a top-level object.
	var wrapper struct {
		Courses []ExternalCourseSummary `json:"courses"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&wrapper); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	return wrapper.Courses, nil
}

// FetchByID retrieves the full course detail (all tees and holes) for the given external ID.
func (c *GolfCourseAPIClient) FetchByID(externalID string) (*ExternalCourseDetail, error) {
	endpoint := fmt.Sprintf("%s/courses/%s", golfCourseAPIBase, url.PathEscape(externalID))

	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Key "+c.apiKey)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck

	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("course not found in external API")
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API returned %d: %s", resp.StatusCode, string(body))
	}

	// GolfCourseAPI wraps the course in a top-level object.
	var wrapper struct {
		Course ExternalCourseDetail `json:"course"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&wrapper); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	return &wrapper.Course, nil
}
