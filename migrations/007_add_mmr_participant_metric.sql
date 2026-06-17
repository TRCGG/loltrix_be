-- MMR / 상대전적 지표 테이블.
-- 한 row = 한 경기의 한 참가자(player-game). 정상 경기 = 10 row.
-- 원천 = replay.raw_data(JSONB 배열). 값은 변환값 저장(game_team blue/red, position enum, game_result 1/0).
-- 자연키 = (custom_match_id, puuid). raw 49 + 파생 14 + 파이프라인.
CREATE TABLE IF NOT EXISTS mmr_participant_metric (
  id                          BIGSERIAL PRIMARY KEY,
  -- 식별 / 메타
  custom_match_id             VARCHAR(255) NOT NULL,   -- = replay.replay_code
  puuid                       VARCHAR(128) NOT NULL,   -- rawData PUUID
  player_code                 VARCHAR(64),             -- 본계정 병합 식별자 (match_participant.player_code와 동일 규칙). H2H 식별 기준
  guild_id                    VARCHAR(128) NOT NULL,
  season                      VARCHAR(32)  NOT NULL,
  champion_id                 VARCHAR(16),             -- SKIN→champion.id (실패 시 NULL)
  game_team                   VARCHAR(8)   NOT NULL,   -- 변환값 blue/red
  position                    VARCHAR(8)   NOT NULL,   -- 변환값 TOP/JUG/MID/ADC/SUP
  game_result                 SMALLINT     NOT NULL,   -- 변환값 1/0
  played_date                 TIMESTAMPTZ  NOT NULL,   -- 업로드 시각(raw에 게임시각 없음), 처리 순서 ASC 기준
  -- raw 49
  kills INTEGER, deaths INTEGER, assists INTEGER,
  double_kills INTEGER, triple_kills INTEGER, quadra_kills INTEGER, penta_kills INTEGER,
  killing_sprees INTEGER, largest_killing_spree INTEGER,
  gold_earned INTEGER, cc_time INTEGER, game_duration INTEGER,
  damage_to_champions INTEGER, damage_taken INTEGER, damage_self_mitigated INTEGER,
  vision_score INTEGER, wards_placed INTEGER, wards_killed INTEGER,
  detector_wards_placed INTEGER, control_wards_bought INTEGER,
  minions_killed INTEGER, neutral_minions_killed INTEGER,
  time_spent_dead INTEGER, longest_time_living INTEGER,
  damage_to_turrets INTEGER, damage_to_objectives INTEGER,
  dragon_kills INTEGER, baron_kills INTEGER, herald_kills INTEGER, horde_kills INTEGER,
  last_takedown_time INTEGER, turrets_killed INTEGER, turret_takedowns INTEGER,
  level INTEGER, exp INTEGER,
  turret_plates_destroyed INTEGER, takedowns_under_turret INTEGER, takedowns_before_15min INTEGER,
  jungle_cs_own INTEGER, jungle_cs_enemy INTEGER, damage_to_epic_monsters INTEGER,
  objectives_stolen INTEGER, barracks_killed INTEGER,
  heal_on_teammates INTEGER, shield_on_teammates INTEGER,
  enemy_missing_pings INTEGER, retreat_pings INTEGER, on_my_way_pings INTEGER, command_pings INTEGER,
  -- 파생 14 (소수 2자리)
  gold_per_min NUMERIC, dpm NUMERIC, damage_taken_per_min NUMERIC, cc_time_per_min NUMERIC,
  exp_per_min NUMERIC, damage_to_turrets_per_min NUMERIC, cs_per_min NUMERIC,
  wards_placed_per_min NUMERIC, wards_killed_per_min NUMERIC,
  kda NUMERIC, damage_taken_per_death NUMERIC, damage_dealt_per_death NUMERIC,
  dead_time_pct NUMERIC, lane_gold_diff NUMERIC,
  -- 파이프라인
  is_mmr_eligible             BOOLEAN      NOT NULL DEFAULT TRUE,
  is_deleted                  BOOLEAN      NOT NULL DEFAULT FALSE,  -- 리플 삭제 시 soft delete
  create_date                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  update_date                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_mmr_participant_metric_match_puuid UNIQUE (custom_match_id, puuid)
);

-- guild_id + season 필터 후 played_date DESC 정렬(자주 만난 상대·최근 윈도우).
CREATE INDEX IF NOT EXISTS idx_mpm_guild_season_played ON mmr_participant_metric (guild_id, season, played_date DESC);
-- 같은 경기 다른 참가자 셀프 조인(custom_match_id 기준).
CREATE INDEX IF NOT EXISTS idx_mpm_custom_match        ON mmr_participant_metric (custom_match_id);
-- 특정 유저의 시즌 전체 평균(시즌 KDA 등) 조회.
CREATE INDEX IF NOT EXISTS idx_mpm_puuid_season        ON mmr_participant_metric (puuid, season);
-- guild + player_code 조회용 (H2H 셀프 조인·집계).
CREATE INDEX IF NOT EXISTS idx_mpm_guild_player        ON mmr_participant_metric (guild_id, player_code);
