-- 004_add_team_tables.sql
-- 팀 관리 기능을 위한 테이블 추가

-- 1. team 테이블
CREATE TABLE IF NOT EXISTS team (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_code       varchar(64) GENERATED ALWAYS AS ('TM_' || lpad(id::text, 6, '0')) STORED NOT NULL UNIQUE,
  name            varchar(128) NOT NULL,
  guild_id        varchar(128) NOT NULL REFERENCES guild(id),
  create_date     timestamp with time zone NOT NULL DEFAULT now(),
  update_date     timestamp with time zone NOT NULL DEFAULT now(),
  is_deleted      boolean NOT NULL DEFAULT false
);

-- 2. team_member 테이블
CREATE TABLE IF NOT EXISTS team_member (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id         integer NOT NULL REFERENCES team(id),
  player_code     varchar(64) NOT NULL REFERENCES riot_account(player_code),
  position        varchar(16),
  is_active       boolean NOT NULL DEFAULT true,
  join_date       timestamp with time zone NOT NULL DEFAULT now(),
  leave_date      timestamp with time zone,
  create_date     timestamp with time zone NOT NULL DEFAULT now(),
  update_date     timestamp with time zone NOT NULL DEFAULT now(),
  is_deleted      boolean NOT NULL DEFAULT false,
  CONSTRAINT uq_team_member_active UNIQUE (team_id, player_code)
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_team_guild_id ON team(guild_id) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_team_member_team_id_active ON team_member(team_id) WHERE is_active = true AND is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_team_member_player_code ON team_member(player_code);
