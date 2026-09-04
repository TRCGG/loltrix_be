-- 대회 신청 항목을 v2로 바꾸고(주포지션 1 + 부포지션 다중 + 선호 챔피언 + 연습량),
-- 로스터에 포지션을 넣어 팀을 TOP/JUG/MID/ADC/SUP 5인 한 명씩으로 고정한다.
-- 포지션 코드는 통계·경기 조회와 같은 TOP/JUG/MID/ADC/SUP, 연습량은 NONE/RARE/MODERATE/OFTEN/ACTIVE.
--
-- 018은 dev에만 적용됐고 그 행들은 전부 시험용이다. 그래서
--   - NOT NULL 컬럼은 임시 DEFAULT로 기존 행을 채운 뒤 DEFAULT를 뗀다 (새 행은 앱이 항상 값을 준다).
--   - captain_available은 VARCHAR 값을 BOOLEAN으로 옮기지 않고 컬럼째 버리고 다시 만든다.
-- 앱 배포 전에 돌려도 된다 — 이 표들을 쓰는 API는 아직 운영에 없다.

ALTER TABLE competition_application
  ADD COLUMN IF NOT EXISTS main_position  VARCHAR(8)    NOT NULL DEFAULT 'MID',
  ADD COLUMN IF NOT EXISTS sub_positions  VARCHAR(8)[]  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS champions      VARCHAR(16)[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS practice_level VARCHAR(16)   NOT NULL DEFAULT 'NONE';

ALTER TABLE competition_application
  ALTER COLUMN main_position DROP DEFAULT,
  ALTER COLUMN practice_level DROP DEFAULT;

-- 이미 BOOLEAN이면 다시 돌려도 값을 날리지 않는다.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'competition_application'
      AND column_name = 'captain_available'
      AND data_type <> 'boolean'
  ) THEN
    ALTER TABLE competition_application DROP COLUMN captain_available;
  END IF;
END $$;

ALTER TABLE competition_application
  ADD COLUMN IF NOT EXISTS captain_available BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE competition_application
  ALTER COLUMN comment TYPE VARCHAR(100) USING LEFT(comment, 100);

ALTER TABLE competition_application
  DROP COLUMN IF EXISTS title,
  DROP COLUMN IF EXISTS position,
  DROP COLUMN IF EXISTS sub_position;

ALTER TABLE competition_application
  DROP CONSTRAINT IF EXISTS ck_competition_application_champions;
ALTER TABLE competition_application
  ADD CONSTRAINT ck_competition_application_champions CHECK (cardinality(champions) <= 3);

ALTER TABLE competition_team_member
  ADD COLUMN IF NOT EXISTS position VARCHAR(8) NOT NULL DEFAULT 'MID';
ALTER TABLE competition_team_member
  ALTER COLUMN position DROP DEFAULT;

-- 임시 DEFAULT로 기존 행이 전부 같은 값이라, 팀 안에서 겹치지 않게 흩뿌린 뒤 유니크를 건다.
-- 6번째 이후 행은 새 규칙(팀당 5명)에서 앉을 자리가 없어 지운다 — dev 시험용 행뿐이다.
-- 유니크가 이미 있으면 이 흩뿌리기가 실제 포지션을 id 순으로 덮어쓰므로 통째로 건너뛴다.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'uq_competition_team_member_position'
      AND c.conrelid = 'competition_team_member'::regclass
      AND n.nspname = current_schema()
  ) THEN
    RETURN;
  END IF;

  DELETE FROM competition_team_member WHERE id IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY team_id ORDER BY id) AS seat
      FROM competition_team_member
    ) ranked WHERE seat > 5
  );

  UPDATE competition_team_member m
  SET position = seats.code
  FROM (
    SELECT id,
           (ARRAY['TOP', 'JUG', 'MID', 'ADC', 'SUP'])[
             ROW_NUMBER() OVER (PARTITION BY team_id ORDER BY id)] AS code
    FROM competition_team_member
  ) seats
  WHERE seats.id = m.id;

  ALTER TABLE competition_team_member
    ADD CONSTRAINT uq_competition_team_member_position UNIQUE (team_id, position);
END $$;
