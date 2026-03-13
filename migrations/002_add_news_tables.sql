-- Migration: Add news system tables
-- Created: 2026-03-13

-- 1. 길드별 뉴스/MMR 구독 설정
CREATE TABLE IF NOT EXISTS news_guild_config (
    guild_id VARCHAR(128) PRIMARY KEY REFERENCES guild(id),
    news_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    mmr_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    channel_id VARCHAR(128),
    tone VARCHAR(20) NOT NULL DEFAULT 'funny',
    create_date TIMESTAMP NOT NULL DEFAULT NOW(),
    update_date TIMESTAMP NOT NULL DEFAULT NOW(),
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE
);

-- 2. 일일 플레이어 통계 (배치 집계용, 영구 보관)
CREATE TABLE IF NOT EXISTS daily_player_stat (
    id SERIAL PRIMARY KEY,
    guild_id VARCHAR(128) NOT NULL REFERENCES guild(id),
    player_name VARCHAR(128) NOT NULL,
    stat_date DATE NOT NULL,
    champion VARCHAR(64) NOT NULL,
    position VARCHAR(16) NOT NULL,

    -- 전투
    games INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    kills INTEGER NOT NULL DEFAULT 0,
    deaths INTEGER NOT NULL DEFAULT 0,
    assists INTEGER NOT NULL DEFAULT 0,

    -- 딜/탱
    damage_to_champions INTEGER NOT NULL DEFAULT 0,
    damage_taken INTEGER NOT NULL DEFAULT 0,
    damage_mitigated INTEGER NOT NULL DEFAULT 0,
    damage_to_buildings INTEGER NOT NULL DEFAULT 0,

    -- 서포트
    heal_on_teammates INTEGER NOT NULL DEFAULT 0,
    shield_on_teammates INTEGER NOT NULL DEFAULT 0,

    -- 시야
    vision_score INTEGER NOT NULL DEFAULT 0,
    wards_placed INTEGER NOT NULL DEFAULT 0,
    wards_killed INTEGER NOT NULL DEFAULT 0,

    -- 멀티킬
    double_kills INTEGER NOT NULL DEFAULT 0,
    triple_kills INTEGER NOT NULL DEFAULT 0,
    quadra_kills INTEGER NOT NULL DEFAULT 0,
    penta_kills INTEGER NOT NULL DEFAULT 0,
    largest_killing_spree INTEGER NOT NULL DEFAULT 0,

    -- 게임 메타
    time_played INTEGER NOT NULL DEFAULT 0,
    time_dead INTEGER NOT NULL DEFAULT 0,
    gold_earned INTEGER NOT NULL DEFAULT 0,

    -- 오브젝트
    dragon_kills INTEGER NOT NULL DEFAULT 0,
    baron_kills INTEGER NOT NULL DEFAULT 0,
    turrets_killed INTEGER NOT NULL DEFAULT 0,

    create_date TIMESTAMP NOT NULL DEFAULT NOW(),
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE
);

-- 멱등성: DELETE → INSERT 시 날짜+길드 기준 삭제용
CREATE INDEX IF NOT EXISTS idx_daily_player_stat_date_guild
    ON daily_player_stat(stat_date, guild_id);

-- 월간 집계: 길드+날짜 범위 조회용
CREATE INDEX IF NOT EXISTS idx_daily_player_stat_guild_date
    ON daily_player_stat(guild_id, stat_date);

-- 유니크: 같은 날 같은 길드에서 같은 플레이어가 같은 챔프+포지션은 1행
ALTER TABLE daily_player_stat
    ADD CONSTRAINT uq_daily_player_stat
    UNIQUE (guild_id, player_name, stat_date, champion, position);

-- 3. 일일 AI 뉴스
CREATE TABLE IF NOT EXISTS daily_news (
    id SERIAL PRIMARY KEY,
    guild_id VARCHAR(128) NOT NULL REFERENCES guild(id),
    news_date DATE NOT NULL,
    title VARCHAR(256),
    discord_content TEXT,
    web_content TEXT,
    stats_json JSONB,
    create_date TIMESTAMP NOT NULL DEFAULT NOW(),
    update_date TIMESTAMP NOT NULL DEFAULT NOW(),
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE
);

ALTER TABLE daily_news
    ADD CONSTRAINT uq_daily_news_guild_date
    UNIQUE (guild_id, news_date);

CREATE INDEX IF NOT EXISTS idx_daily_news_guild_date
    ON daily_news(guild_id, news_date);

-- 4. 월간 AI 뉴스
CREATE TABLE IF NOT EXISTS monthly_news (
    id SERIAL PRIMARY KEY,
    guild_id VARCHAR(128) NOT NULL REFERENCES guild(id),
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    title VARCHAR(256),
    discord_content TEXT,
    web_content TEXT,
    stats_json JSONB,
    create_date TIMESTAMP NOT NULL DEFAULT NOW(),
    update_date TIMESTAMP NOT NULL DEFAULT NOW(),
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE
);

ALTER TABLE monthly_news
    ADD CONSTRAINT uq_monthly_news_guild_period
    UNIQUE (guild_id, year, month);

CREATE INDEX IF NOT EXISTS idx_monthly_news_guild_period
    ON monthly_news(guild_id, year, month);
