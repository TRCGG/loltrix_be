CREATE TABLE IF NOT EXISTS player_mmr (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    puuid VARCHAR(128) NOT NULL,
    guild_id VARCHAR(128) NOT NULL,
    mmr INTEGER NOT NULL DEFAULT 1300,
    games_played INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    last_match_id VARCHAR(255),
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    update_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT player_mmr_puuid_guild_unq UNIQUE (puuid, guild_id)
);

CREATE TABLE IF NOT EXISTS mmr_history (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    custom_match_id VARCHAR(255) NOT NULL,
    puuid VARCHAR(128) NOT NULL,
    guild_id VARCHAR(128) NOT NULL,
    pre_mmr INTEGER NOT NULL,
    post_mmr INTEGER NOT NULL,
    delta INTEGER NOT NULL,
    game_result VARCHAR(8) NOT NULL,
    position VARCHAR(16) NOT NULL,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT mmr_history_match_puuid_unq UNIQUE (custom_match_id, puuid)
);

CREATE INDEX IF NOT EXISTS idx_mmr_history_puuid_guild_date
    ON mmr_history (puuid, guild_id, create_date);
