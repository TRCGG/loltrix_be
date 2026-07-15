-- 토너먼트코드 MVP (TRC-225) 스키마 통합본.
-- 구성: 발급 체인 테이블 4종 + match_v5_raw 원본 보존(구 012) + 폴링 파라미터 시드(구 013)
--       + tournament_code.game_type(경기 유형) — 별도 파일이던 012~014를 이 파일로 통합.
-- 전체가 멱등(IF NOT EXISTS / ON CONFLICT DO NOTHING)이라 구 008/011로 일부 적용된 DB(dev)에도
-- 파일 전체 재실행으로 안전하게 나머지가 반영된다.
-- 기존 테이블·마이그레이션(001~010)은 건드리지 않는다.

-- 토너먼트 프로바이더 (Riot provider 등록 결과). 보통 활성 1행, 재등록 이력 누적 가능.
CREATE TABLE IF NOT EXISTS tournament_provider (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_id   INTEGER      NOT NULL,           -- Riot provider id
  region        VARCHAR(8)   NOT NULL,           -- KR
  callback_url  VARCHAR(512) NOT NULL,
  create_date   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  update_date   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  is_deleted    BOOLEAN      NOT NULL DEFAULT FALSE
);

-- 토너먼트 (Riot tournament 등록 결과). provider 하위.
CREATE TABLE IF NOT EXISTS tournament (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tournament_id INTEGER      NOT NULL,           -- Riot tournament id
  provider_id   INTEGER      NOT NULL,           -- Riot provider id
  name          VARCHAR(128) NOT NULL,
  create_date   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  update_date   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  is_deleted    BOOLEAN      NOT NULL DEFAULT FALSE
);

-- 토너먼트 코드. 선발급 코드 1개 = 1행.
-- status PENDING(미사용) → COMPLETED(적재됨) / INVALID(무효).
-- custom_match_id는 경기 적재 시 채워짐(발급 시점 NULL). metadata는 코드 임베드 메타.
-- game_type: 발급 시 지정한 경기 유형(1=일반내전/2=스크림/3=대회) — MVP raw-only에선 코드에만 기록,
--            추후 raw→정규화 승격 시 custom_match.game_type으로 전파.
CREATE TABLE IF NOT EXISTS tournament_code (
  code            VARCHAR(128) PRIMARY KEY,
  tournament_id   INTEGER      NOT NULL,
  guild_id        VARCHAR(128) NOT NULL,
  game_type       CHAR(1)      NOT NULL DEFAULT '1',   -- 1=일반내전/2=스크림/3=대회
  custom_match_id VARCHAR(255),                        -- 사용 후 채워짐
  metadata        JSONB,
  status          VARCHAR(16)  NOT NULL DEFAULT 'PENDING',
  issued_date     TIMESTAMPTZ  NOT NULL DEFAULT NOW(), -- 발급 시각
  used_date       TIMESTAMPTZ,                         -- 사용(경기 완료) 시각
  create_date     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  update_date     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  is_deleted      BOOLEAN      NOT NULL DEFAULT FALSE
);

-- game_type 이전(구 008/011)으로 tournament_code가 이미 생성된 DB(dev) 대응 — 컬럼만 추가.
-- 기존 행은 전부 일반내전이므로 DEFAULT '1' 백필로 충분.
ALTER TABLE tournament_code
  ADD COLUMN IF NOT EXISTS game_type CHAR(1) NOT NULL DEFAULT '1';

-- 폴백 폴링: PENDING 코드를 issued_date 기준으로 조회.
CREATE INDEX IF NOT EXISTS idx_tournament_code_status_issued ON tournament_code (status, issued_date);
-- 길드별 코드 조회.
CREATE INDEX IF NOT EXISTS idx_tournament_code_guild         ON tournament_code (guild_id);
-- 적재된 경기 → 코드 역조회.
CREATE INDEX IF NOT EXISTS idx_tournament_code_custom_match  ON tournament_code (custom_match_id);

-- 밴픽 밴 정보. Match-V5 info.teams[].bans[] → 1밴 = 1행.
-- champion_id는 champion.id(varchar) 관례. 밴 없음(-1)이면 NULL. team=blue/red, ban_order=pickTurn.
-- ⚠️ MVP raw-only 결정(2026-07-15)으로 현재 적재 경로는 이 테이블에 쓰지 않는다.
--    dev DB에 이미 존재해 테이블은 유지 — 추후 raw→정규화 승격 시 사용.
CREATE TABLE IF NOT EXISTS match_ban (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  custom_match_id VARCHAR(255) NOT NULL REFERENCES custom_match (id),
  team            VARCHAR(8)   NOT NULL,
  champion_id     VARCHAR(16),
  ban_order       INTEGER      NOT NULL,
  create_date     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  update_date     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  is_deleted      BOOLEAN      NOT NULL DEFAULT FALSE,
  CONSTRAINT uq_match_ban_match_team_order UNIQUE (custom_match_id, team, ban_order)
);

-- 같은 경기 밴 조회.
CREATE INDEX IF NOT EXISTS idx_match_ban_custom_match ON match_ban (custom_match_id);

-- Match-V5 원본 보존 테이블 (구 012 — 대회 경기 전체 데이터 확보).
-- MVP raw-only 결정(2026-07-15): 토너먼트코드 적재는 이 테이블에만 저장한다.
-- 정규화(custom_match/match_participant/metric/match_ban)는 하지 않으므로
-- custom_match FK 없이 match-v5 matchId(match_id)를 직접 키로 쓰는 독립 테이블.
-- 필요한 지표는 추후 raw에서 backfill로 정규화 테이블에 승격.
-- timeline_json은 별도 API 호출이라 실패 시 NULL 허용(적재를 막지 않음, 추후 backfill 가능).
-- source: 적재 출처 구분 — 현재 TOURNAMENT(대회), 추후 일반내전 등 확장 대비.
-- ⚠️ 구 정의(custom_match_id FK)로 이미 생성된 DB는 없음(dev 미적용 상태에서 변경, 2026-07-15).
CREATE TABLE IF NOT EXISTS match_v5_raw (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  match_id        VARCHAR(255) NOT NULL,               -- match-v5 matchId (예: KR_123...) — 멱등 키
  guild_id        VARCHAR(128) NOT NULL REFERENCES guild (id),
  source          VARCHAR(16)  NOT NULL DEFAULT 'TOURNAMENT',
  match_json      JSONB        NOT NULL,               -- match-v5 응답 원본 전체
  timeline_json   JSONB,                               -- match-v5 timeline 원본(조회 실패 시 NULL)
  create_date     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  update_date     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  is_deleted      BOOLEAN      NOT NULL DEFAULT FALSE,
  CONSTRAINT uq_match_v5_raw_match UNIQUE (match_id)
);

-- 길드별 원본 조회.
CREATE INDEX IF NOT EXISTS idx_match_v5_raw_guild ON match_v5_raw (guild_id);

-- 토너먼트 폴링 운영 파라미터 system_config 시드 (구 013).
-- 폴링 잡이 매 주기 읽으므로 DB에서 값을 바꾸면 재배포·재시작 없이 즉시 반영된다.
-- 행이 없어도 코드 기본값(1h / 3h)으로 동작 — 시드는 운영 가시성·조정 편의 목적.
INSERT INTO system_config (key, value, description) VALUES
  ('TOURNAMENT_POLL_MIN_AGE_HOURS', '1', '토너먼트 폴백 폴링: 발급 후 이 시간(시간) 이상 지난 PENDING 코드만 회수 대상'),
  ('TOURNAMENT_CODE_EXPIRE_HOURS', '3', '토너먼트 코드 만료: 발급 후 이 시간(시간) 지나도록 미사용(PENDING)이면 INVALID 전이')
ON CONFLICT (key) DO NOTHING;
