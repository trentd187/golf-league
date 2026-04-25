-- follows: directed follow relationship from follower_id to followee_id.
-- Composite PK enforces uniqueness and covers the primary lookup direction (follower → followees).
-- Secondary index covers the reverse direction (followee → followers).
CREATE TABLE follows (
    follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    followee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (follower_id, followee_id)
);

CREATE INDEX idx_follows_followee ON follows(followee_id);
