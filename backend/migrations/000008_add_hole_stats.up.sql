-- 000008_add_hole_stats.up.sql
-- Creates the hole_stats table for per-hole advanced statistics (GIR, FIR, putts, distances).
-- Stored separately from scores so stats can be entered independently of gross score entry.

CREATE TABLE hole_stats (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    round_player_id     UUID        NOT NULL REFERENCES round_players(id) ON DELETE CASCADE,
    hole_number         INT         NOT NULL, -- 1–18
    -- Green in Regulation: "hit" = on green in regulation, "miss" = missed, "na" = not applicable
    gir                 TEXT        CHECK (gir IN ('hit', 'miss', 'na')),
    -- Direction of a missed approach to the green
    gir_miss_direction  TEXT        CHECK (gir_miss_direction IN ('short', 'left', 'right', 'long')),
    -- Fairway in Regulation: true = hit the fairway, false = missed
    fir                 BOOLEAN,
    -- Direction of a missed drive
    fir_miss_direction  TEXT        CHECK (fir_miss_direction IN ('short', 'left', 'right', 'long')),
    putts               INT         CHECK (putts >= 0),
    first_putt_distance INT         CHECK (first_putt_distance >= 0), -- feet
    putt_distance_made  INT         CHECK (putt_distance_made >= 0),  -- feet
    entered_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (round_player_id, hole_number)
);
