-- 첫 실행은 새 예선(game_type=3) 입력을 열기 전 유지보수 구간에 실행한다.
-- 저장된 값만으로 과거 본경기 3과 새 예선 3을 구별할 수 없다.
-- 삭제 경기·종료 대회·대회 미지정·미사용 코드·고아 행도 과거 3이면 모두 본선 4로 옮긴다.

BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '10s';

-- 최초 history 테이블 생성부터 직렬화해야 동시 실행이 같은 이관을 두 번 시도하지 않는다.
SELECT pg_advisory_xact_lock(hashtext('loltrix:data-migration'), hashtext('021_migrate_main_game_type'));

CREATE TABLE IF NOT EXISTS data_migration_history (
  migration_key VARCHAR(128) PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL,
  row_counts JSONB NOT NULL
);

DO $$
DECLARE
  v_migration_key CONSTANT TEXT := '021_migrate_main_game_type';
  conflicting_match TEXT;
  replay_count BIGINT;
  custom_match_count BIGINT;
  metric_count BIGINT;
  tournament_code_count BIGINT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM data_migration_history h WHERE h.migration_key = v_migration_key
  ) THEN
    RAISE NOTICE 'Migration % already applied; skipping', v_migration_key;
    RETURN;
  END IF;

  -- 가드와 UPDATE 사이의 INSERT/UPDATE/DELETE를 막는다. 일반 SELECT는 허용한다.
  LOCK TABLE replay, custom_match, mmr_participant_metric, tournament_code
    IN SHARE ROW EXCLUSIVE MODE;

  SELECT copies.match_id INTO conflicting_match
  FROM (
    SELECT replay_code AS match_id,
      CASE WHEN game_type IN ('3', '4') THEN '4' ELSE game_type END AS target_type
    FROM replay
    UNION ALL
    SELECT id AS match_id,
      CASE WHEN game_type IN ('3', '4') THEN '4' ELSE game_type END AS target_type
    FROM custom_match
    UNION ALL
    SELECT custom_match_id AS match_id,
      CASE WHEN game_type IN ('3', '4') THEN '4' ELSE game_type END AS target_type
    FROM mmr_participant_metric
  ) copies
  GROUP BY copies.match_id
  HAVING count(DISTINCT copies.target_type) > 1
  LIMIT 1;

  IF conflicting_match IS NOT NULL THEN
    RAISE EXCEPTION
      'Game type copies disagree for match %. Resolve the inconsistency before migration; types 1/2 will not be changed.',
      conflicting_match;
  END IF;

  UPDATE replay SET game_type = '4', update_date = CURRENT_TIMESTAMP WHERE game_type = '3';
  GET DIAGNOSTICS replay_count = ROW_COUNT;

  UPDATE custom_match SET game_type = '4', update_date = CURRENT_TIMESTAMP WHERE game_type = '3';
  GET DIAGNOSTICS custom_match_count = ROW_COUNT;

  UPDATE mmr_participant_metric SET game_type = '4', update_date = CURRENT_TIMESTAMP WHERE game_type = '3';
  GET DIAGNOSTICS metric_count = ROW_COUNT;

  UPDATE tournament_code SET game_type = '4', update_date = CURRENT_TIMESTAMP WHERE game_type = '3';
  GET DIAGNOSTICS tournament_code_count = ROW_COUNT;

  -- 데이터 변경과 marker를 함께 커밋해야 재실행 때 새 예선 3을 건드리지 않는다.
  INSERT INTO data_migration_history (migration_key, applied_at, row_counts)
  VALUES (
    v_migration_key,
    clock_timestamp(),
    jsonb_build_object(
      'replay', replay_count,
      'custom_match', custom_match_count,
      'mmr_participant_metric', metric_count,
      'tournament_code', tournament_code_count
    )
  );
END $$;

COMMIT;
