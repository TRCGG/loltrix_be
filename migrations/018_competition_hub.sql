-- 대회 허브: 대회 생애주기 3단계 + 신청·팀·로스터·경기 귀속 테이블.
-- competition(016)은 이미 운영에 있어 ALTER로 고치고, 나머지 네 표는 처음 만든다.
--
-- 순서 주의 1: status backfill이 인덱스 교체보다 먼저다. 새 코드에는 OPEN이 없어, OPEN으로 남은 행은
--   어떤 상태 조회에도 걸리지 않고 리플 태깅 대상에서 통째로 빠진다.
-- 순서 주의 2: 이 파일과 앱 리로드 사이에는 어느 쪽을 먼저 해도 깨지는 구간이 있다. 트래픽이 없는
--   시간에 돌리고 곧바로 앱을 리로드해 그 구간을 좁힌다.
--   파일 먼저: 구 코드가 status='OPEN'으로 insert해 새 CHECK에 걸리고, OPEN을 찾는 !대회종료·리플 저장이 대상을 못 찾는다.
--   리로드 먼저: 새 코드가 IN_PROGRESS를 못 찾아 !대회종료·리플 저장이 전부 실패한다.

-- ── 대회 상태: 모집중(RECRUITING) / 진행중(IN_PROGRESS) / 종료(CLOSED) ──
-- 모집중은 길드에 여러 개 둘 수 있고, 리플이 대회명 없이 자동으로 붙는 진행중만 하나로 제한한다.
UPDATE competition SET status = 'IN_PROGRESS' WHERE status = 'OPEN';

DROP INDEX IF EXISTS uq_competition_guild_open;

CREATE UNIQUE INDEX IF NOT EXISTS uq_competition_guild_in_progress
  ON competition (guild_id) WHERE status = 'IN_PROGRESS';

-- false면 신청이 들어오는 즉시 APPROVED로 저장된다 (운영진 승인 단계를 건너뛰는 대회).
ALTER TABLE competition
  ADD COLUMN IF NOT EXISTS approval_required BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE competition
  ALTER COLUMN status SET DEFAULT 'RECRUITING';

ALTER TABLE competition
  DROP CONSTRAINT IF EXISTS ck_competition_status;
ALTER TABLE competition
  ADD CONSTRAINT ck_competition_status
  CHECK (status IN ('RECRUITING', 'IN_PROGRESS', 'CLOSED'));

-- ── 신청·팀·로스터·경기 귀속 ──
-- competition은 remove()가 hard-delete이므로 대회 계열 FK는 전부 ON DELETE CASCADE.
-- player_code는 전부 riot_account(player_code) 참조 — 로스터·신청은 본계정으로 정규화해 저장한다.
-- 포지션 코드는 통계·경기 조회와 같은 TOP/JUG/MID/ADC/SUP, 연습량은 NONE/RARE/MODERATE/OFTEN/ACTIVE.

-- 개인 신청. 승인(APPROVED)은 로스터 등록의 전제가 아니다 — 운영진이 직접 넣을 수 있다.
CREATE TABLE IF NOT EXISTS competition_application (
  id                     SERIAL        PRIMARY KEY,
  competition_id         INTEGER       NOT NULL REFERENCES competition(id) ON DELETE CASCADE,
  player_code            VARCHAR(64)   NOT NULL REFERENCES riot_account(player_code),
  applied_by_member_id   VARCHAR(64)   NOT NULL,   -- 신청을 넣은 Discord 멤버 (본인 확인은 하지 않는다)
  main_position          VARCHAR(8)    NOT NULL,
  sub_positions          VARCHAR(8)[]  NOT NULL DEFAULT '{}',
  champions              VARCHAR(16)[] NOT NULL DEFAULT '{}',   -- champion.id
  available_time         VARCHAR(128),
  captain_available      BOOLEAN       NOT NULL DEFAULT false,
  practice_level         VARCHAR(16)   NOT NULL,
  comment                VARCHAR(100),
  status                 VARCHAR(16)   NOT NULL DEFAULT 'PENDING',  -- PENDING / APPROVED / REJECTED
  decided_by_member_id   VARCHAR(64),
  decided_date           TIMESTAMPTZ,
  create_date            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  update_date            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_competition_application UNIQUE (competition_id, player_code),
  CONSTRAINT ck_competition_application_champions CHECK (cardinality(champions) <= 3)
);

CREATE TABLE IF NOT EXISTS competition_team (
  id                   SERIAL       PRIMARY KEY,
  competition_id       INTEGER      NOT NULL REFERENCES competition(id) ON DELETE CASCADE,
  name                 VARCHAR(64)  NOT NULL,
  captain_player_code  VARCHAR(64)  REFERENCES riot_account(player_code),
  create_date          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_competition_team_name UNIQUE (competition_id, name)
);

-- competition_id는 team_id에서 유도 가능하지만, "한 대회에서 한 팀만"을 DB 유니크로 걸려면 여기 있어야 한다.
-- 팀당 5명 상한은 (team_id, position) 유니크가 대신한다.
CREATE TABLE IF NOT EXISTS competition_team_member (
  id             SERIAL       PRIMARY KEY,
  competition_id INTEGER      NOT NULL REFERENCES competition(id) ON DELETE CASCADE,
  team_id        INTEGER      NOT NULL REFERENCES competition_team(id) ON DELETE CASCADE,
  player_code    VARCHAR(64)  NOT NULL REFERENCES riot_account(player_code),
  position       VARCHAR(8)   NOT NULL,
  create_date    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_competition_team_member_player   UNIQUE (competition_id, player_code),
  CONSTRAINT uq_competition_team_member_position UNIQUE (team_id, position)
);

CREATE INDEX IF NOT EXISTS idx_competition_team_member_team
  ON competition_team_member (team_id);

-- 경기의 팀 귀속. 로스터에서 역산하지 않고 명시 저장한다 — 교체·용병 시점과 경기 시점이 어긋나도
-- 전적이 흔들리지 않게. team_id NULL은 용병전(로스터 소속 0명)이며 팀 전적에서 빠진다.
CREATE TABLE IF NOT EXISTS competition_match_team (
  id              SERIAL       PRIMARY KEY,
  custom_match_id VARCHAR(255) NOT NULL REFERENCES custom_match(id) ON DELETE CASCADE,
  game_team       VARCHAR(8)   NOT NULL,   -- blue / red
  team_id         INTEGER      REFERENCES competition_team(id) ON DELETE CASCADE,
  create_date     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_competition_match_team UNIQUE (custom_match_id, game_team)
);

-- 팀 전적 조회는 team_id로 들어오고 용병전(NULL) 행은 대상이 아니라 부분 인덱스.
CREATE INDEX IF NOT EXISTS idx_competition_match_team_team
  ON competition_match_team (team_id) WHERE team_id IS NOT NULL;
