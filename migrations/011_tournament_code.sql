-- 토너먼트코드 MVP (TRC-225) 스키마. 발급 체인 + 밴픽 저장용 테이블 4종.
-- tournament_provider / tournament : Riot Tournament(-stub) API 등록 결과(dev 키 24h 만료 → 재등록).
-- tournament_code : 선발급 코드 1개 = 1행. status PENDING → COMPLETED / INVALID.
-- match_ban : Match-V5 밴 1개 = 1행.
-- 기존 테이블·마이그레이션(001~007)은 건드리지 않는다.

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
CREATE TABLE IF NOT EXISTS tournament_code (
  code            VARCHAR(128) PRIMARY KEY,
  tournament_id   INTEGER      NOT NULL,
  guild_id        VARCHAR(128) NOT NULL,
  custom_match_id VARCHAR(255),                        -- 사용 후 채워짐
  metadata        JSONB,
  status          VARCHAR(16)  NOT NULL DEFAULT 'PENDING',
  issued_date     TIMESTAMPTZ  NOT NULL DEFAULT NOW(), -- 발급 시각
  used_date       TIMESTAMPTZ,                         -- 사용(경기 완료) 시각
  create_date     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  update_date     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  is_deleted      BOOLEAN      NOT NULL DEFAULT FALSE
);

-- 폴백 폴링: PENDING 코드를 issued_date 기준으로 조회.
CREATE INDEX IF NOT EXISTS idx_tournament_code_status_issued ON tournament_code (status, issued_date);
-- 길드별 코드 조회.
CREATE INDEX IF NOT EXISTS idx_tournament_code_guild         ON tournament_code (guild_id);
-- 적재된 경기 → 코드 역조회.
CREATE INDEX IF NOT EXISTS idx_tournament_code_custom_match  ON tournament_code (custom_match_id);

-- 밴픽 밴 정보. Match-V5 info.teams[].bans[] → 1밴 = 1행.
-- champion_id는 champion.id(varchar) 관례. 밴 없음(-1)이면 NULL. team=blue/red, ban_order=pickTurn.
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
