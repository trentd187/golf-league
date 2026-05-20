ALTER TABLE events
    ADD COLUMN is_public BOOL NOT NULL DEFAULT FALSE;

ALTER TYPE event_player_status ADD VALUE IF NOT EXISTS 'pending';
