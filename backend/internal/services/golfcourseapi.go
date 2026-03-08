// Package services contains clients for external services used by the Golf League API.
// This file implements a client for GolfCourseAPI.com, a free API that provides
// course information including hole-by-hole par, yardage, and stroke indexes.
//
// Verified against the official OpenAPI spec (openapi.yml):
//   - Search endpoint: GET /v1/search?search_query=<term>  (not /v1/courses?search=)
//   - Location fields are nested under a "location" object (not flat)
//   - Tees are split into tees.male[] and tees.female[] (not a flat array)
//   - Hole number is positional (1-indexed) — no explicit hole_number field
//   - All IDs are JSON numbers, not strings
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
// These structs exactly match GolfCourseAPI.com's JSON response shapes.

// ExternalLocation is the nested location object inside every course record.
type ExternalLocation struct {
	City    string `json:"city"`
	State   string `json:"state"`
	Country string `json:"country"`
}

// ExternalHole describes one hole. Holes are positionally ordered in the array —
// GolfCourseAPI does not include a hole_number field; array index + 1 = hole number.
type ExternalHole struct {
	Par         int `json:"par"`
	StrokeIndex int `json:"handicap"` // GolfCourseAPI calls stroke index "handicap"
	Yardage     int `json:"yardage"`
}

// ExternalTeeBox describes one tee set. Gender is not a field here — it is
// determined by whether this tee appears in ExternalCourseTees.Male or .Female.
type ExternalTeeBox struct {
	TeeName      string         `json:"tee_name"`
	CourseRating float64        `json:"course_rating"`
	SlopeRating  int            `json:"slope_rating"`
	Par          int            `json:"par_total"` // total par for all holes
	NumHoles     int            `json:"number_of_holes"`
	Holes        []ExternalHole `json:"holes"`
}

// ExternalCourseTees holds tee sets split by gender as returned by the API.
type ExternalCourseTees struct {
	Male   []ExternalTeeBox `json:"male"`
	Female []ExternalTeeBox `json:"female"`
}

// ExternalCourse is the course record shape used by both the search and detail endpoints.
// Both /v1/search and /v1/courses/{id} return this structure — search returns an array,
// detail wraps one in a {"course": ...} envelope.
type ExternalCourse struct {
	ID         int                `json:"id"`
	ClubName   string             `json:"club_name"`
	CourseName string             `json:"course_name"`
	Location   ExternalLocation   `json:"location"`
	Tees       ExternalCourseTees `json:"tees"`
}

// IsConfigured reports whether an API key has been provided.
// Handlers call this before making any external API requests and return 503 if false,
// so the caller gets a clear error instead of a cryptic 401 from GolfCourseAPI.
func (c *GolfCourseAPIClient) IsConfigured() bool {
	return c.apiKey != ""
}

// ─── API methods ───────────────────────────────────────────────────────────────

// Search queries GolfCourseAPI for courses matching the given search term.
// The API matches against course name and club name; location context (e.g. "Pebble Beach CA")
// can be included in the search term to narrow results.
// Endpoint: GET /v1/search?search_query=<term>
func (c *GolfCourseAPIClient) Search(searchTerm string) ([]ExternalCourse, error) {
	// The search endpoint is /v1/search, distinct from /v1/courses/{id}.
	// The query param is "search_query" (not "search") per the OpenAPI spec.
	endpoint := fmt.Sprintf("%s/search?search_query=%s", golfCourseAPIBase, url.QueryEscape(searchTerm))

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

	// GolfCourseAPI wraps results in {"courses": [...]}
	var wrapper struct {
		Courses []ExternalCourse `json:"courses"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&wrapper); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	return wrapper.Courses, nil
}

// FetchByID retrieves the full course detail (all tees and holes) for the given external ID.
// Endpoint: GET /v1/courses/{id}
func (c *GolfCourseAPIClient) FetchByID(externalID string) (*ExternalCourse, error) {
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

	// GolfCourseAPI wraps the course in {"course": {...}}
	var wrapper struct {
		Course ExternalCourse `json:"course"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&wrapper); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	return &wrapper.Course, nil
}
