-- 대회 신청·팀 로스터·경기의 팀 귀속. 대회(competition) 안에서 "어느 팀이 이겼는지"를 남긴다.
-- custom_match에는 blue/red만 있어 팀 vs 팀 전적을 낼 수 없었다.
--
-- competition은 remove()가 hard-delete이므로 대회 계열 FK는 전부 ON DELETE CASCADE.
-- player_code는 전부 riot_account(player_code) 참조 — 로스터·신청은 본계정으로 정규화해 저장한다.

-- 개인 신청. 승인(APPROVED)은 로스터 등록의 전제가 아니다 — 운영진이 직접 넣을 수 있다.
CREATE TABLE IF NOT EXISTS competition_application (
  id                     SERIAL       PRIMARY KEY,
  competition_id         INTEGER      NOT NULL REFERENCES competition(id) ON DELETE CASCADE,
  player_code            VARCHAR(64)  NOT NULL REFERENCES riot_account(player_code),
  applied_by_member_id   VARCHAR(64)  NOT NULL,   -- 신청을 넣은 Discord 멤버 (본인 확인은 하지 않는다)
  title                  VARCHAR(64)  NOT NULL,
  available_time         VARCHAR(128),
  captain_available      VARCHAR(64),
  position               VARCHAR(16),
  sub_position           VARCHAR(16),
  comment                VARCHAR(256),
  status                 VARCHAR(16)  NOT NULL DEFAULT 'PENDING',  -- PENDING / APPROVED / REJECTED
  decided_by_member_id   VARCHAR(64),
  decided_date           TIMESTAMPTZ,
  create_date            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  update_date            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_competition_application UNIQUE (competition_id, player_code)
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
CREATE TABLE IF NOT EXISTS competition_team_member (
  id             SERIAL       PRIMARY KEY,
  competition_id INTEGER      NOT NULL REFERENCES competition(id) ON DELETE CASCADE,
  team_id        INTEGER      NOT NULL REFERENCES competition_team(id) ON DELETE CASCADE,
  player_code    VARCHAR(64)  NOT NULL REFERENCES riot_account(player_code),
  create_date    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_competition_team_member_player UNIQUE (competition_id, player_code)
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
