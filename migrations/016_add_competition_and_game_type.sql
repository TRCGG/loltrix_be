-- 대회(competition): 클랜 안에서 여는 이벤트 단위 (예: 멸망전 1회, 멸망전 2회).
-- 스크림(game_type 2)·본경기(game_type 3) 경기가 어느 대회 것인지 잇는다. 일반내전(1)은 NULL.
--
-- 가드: 이미 2/3으로 저장된 경기가 있으면 멈춘다. 이 마이그레이션 뒤에는 그 경기가 일반내전 조회에서 빠지는데
-- competition_id가 NULL이라 어떤 대회 조회에도 안 잡히는 "유령 경기"가 되기 때문이다.
-- 확인 후 의도적으로 진행하려면 해당 경기를 수동 배정할 대회를 먼저 정하고 이 블록을 지운 뒤 실행한다.
DO $$
DECLARE tagged integer;
BEGIN
  SELECT count(*) INTO tagged FROM custom_match WHERE game_type <> '1';
  IF tagged > 0 THEN
    RAISE EXCEPTION 'custom_match에 game_type 2/3 경기 %건이 있습니다. 대회 수동 배정 계획을 세운 뒤 이 가드를 지우고 다시 실행하세요.', tagged;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS competition (
  id          SERIAL       PRIMARY KEY,
  guild_id    VARCHAR(128) NOT NULL,
  name        VARCHAR(64)  NOT NULL,
  season      VARCHAR(32)  NOT NULL,
  status      VARCHAR(16)  NOT NULL DEFAULT 'OPEN',   -- OPEN / CLOSED
  create_date TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  close_date  TIMESTAMPTZ,
  CONSTRAINT uq_competition_guild_name UNIQUE (guild_id, name)
);

-- 길드당 OPEN 대회는 하나만. 봇이 대회명 생략 시 이 한 건에 자동 태깅한다.
CREATE UNIQUE INDEX IF NOT EXISTS uq_competition_guild_open
  ON competition (guild_id) WHERE status = 'OPEN';

ALTER TABLE replay
  ADD COLUMN IF NOT EXISTS competition_id INTEGER REFERENCES competition(id);
ALTER TABLE custom_match
  ADD COLUMN IF NOT EXISTS competition_id INTEGER REFERENCES competition(id);

-- H2H·MMR 조회는 custom_match를 조인하지 않으므로 유형을 여기에도 복제한다.
-- 대회 id는 복제하지 않는다 — 대회별 상대전적은 범위 밖이고, 필요해지면 custom_match 조인으로 건다.
ALTER TABLE mmr_participant_metric
  ADD COLUMN IF NOT EXISTS game_type CHAR(1) NOT NULL DEFAULT '1';

-- competition_id는 대부분 NULL(일반내전)이라 부분 인덱스. replay 것은 대회 삭제 시 FK 검사용.
CREATE INDEX IF NOT EXISTS idx_replay_competition
  ON replay (competition_id) WHERE competition_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_custom_match_competition
  ON custom_match (competition_id) WHERE competition_id IS NOT NULL;

-- 기존 행 backfill: custom_match에 이미 2/3으로 태깅된 경기만 game_type 갱신.
-- competition_id는 대회 정보가 없으므로 NULL(대회 미지정)로 남긴다 — 필요 시 수동 배정.
UPDATE mmr_participant_metric m
SET game_type = c.game_type
FROM custom_match c
WHERE m.custom_match_id = c.id
  AND c.game_type <> '1'
  AND m.game_type <> c.game_type;
