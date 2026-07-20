-- ════════════════════════════════════════════════════════════════════════
-- [TRC-243] 부캐 병합 player_code 원복 (쓰기 — 단일 트랜잭션)
-- ════════════════════════════════════════════════════════════════════════
-- 부캐저장이 본캐로 덮어쓴 player_code를 raw 원본(PUUID) 기준으로 되돌린다.
--   - match_participant       : replay.raw_data 역산 매핑으로 원복
--   - mmr_participant_metric  : 자체 puuid 컬럼으로 원복 (병합·NULL·dangling 일괄)
--   - 토너먼트 경기는 raw-only 적재(TRC-225, match_participant 미적재)라 역산 대상 없음
--
-- 실행 방법:
--   1) dry-run — 맨 아래 COMMIT을 ROLLBACK으로 바꿔 실행하고 리포트만 확인
--   2) 실제 반영 — COMMIT 그대로 실행
--   (데이터가 많으면 BEGIN 앞에 SET work_mem = '128MB'; 로 세션 한정 가속 가능)
--
-- 주의:
--   - 멱등: 재실행 시 원복 대상 0행 (이미 원복된 행은 조건 불일치로 스킵)
--   - is_deleted = false 행만 대상
--   - ⚠️ 운영 실행은 A안 조회 전환(effective 매핑) 배포와 동시에 한다 (TRC-243 결정 #5).
--     현행(병합 읽기 전제) 코드에서 원복만 먼저 하면 본캐/부캐 통계가 분리되어 보인다.
--   - 사전 검증 실패 시 RAISE EXCEPTION으로 전체 트랜잭션이 중단된다.
-- 선행 조사 스크립트(subaccount_link_status / merged_match_participant / merged_mmr_metric)는
-- 일회성 조회용이라 레포 미보존 — 필요 시 본 파일의 매핑 CTE로 재구성 가능.
--
-- 실행 이력:
--   - dev(gtrix_dev_v2): 2026-07-15 COMMIT 적용 — mp 84행 + metric 647행 원복, 사후 잔여 0, 멱등 확인
--   - 운영: PR #41(dev→main) 배포와 동시 실행 (완료 시 이력 추가)
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 0. 원복 매핑 생성 (조사 스크립트와 동일 로직) ─────────────────────────
CREATE TEMP TABLE tmp_mp_restore ON COMMIT DROP AS
WITH raw_p AS (
  -- 리플 경로: replay.raw_data
  -- replay.is_deleted 필터 없음: replay가 soft-delete돼도 custom_match·mp가 살아있는
  -- 경우가 있어(재업로드 dedup 등) 원본 증거로는 raw_data를 그대로 쓴다.
  -- ※ 토너먼트 경기는 raw-only 적재(TRC-225, match_participant 미적재)라 역산 대상 없음.
  --    추후 raw→정규화 backfill 승격 시에만 match_v5_raw 역산 UNION ALL 추가.
  SELECT
    cm.id       AS custom_match_id,
    cm.guild_id,
    p->>'PUUID' AS puuid,
    p->>'SKIN'  AS champ_name,
    CASE p->>'TEAM' WHEN '100' THEN 'blue' WHEN '200' THEN 'red' ELSE p->>'TEAM' END AS game_team,
    CASE p->>'TEAM_POSITION'
      WHEN 'JUNGLE' THEN 'JUG' WHEN 'BOTTOM' THEN 'ADC' WHEN 'UTILITY' THEN 'SUP'
      WHEN 'MIDDLE' THEN 'MID' WHEN 'TOP' THEN 'TOP'
      ELSE COALESCE(p->>'TEAM_POSITION', '') END AS position
  FROM replay r
  JOIN custom_match cm ON cm.id = r.replay_code AND cm.is_deleted = false
  CROSS JOIN LATERAL jsonb_array_elements(r.raw_data) p
),
raw_resolved AS (
  SELECT rp.*, ra.player_code AS origin_player_code, ch.id AS champion_id
  FROM raw_p rp
  LEFT JOIN riot_account ra ON ra.puuid = rp.puuid
  LEFT JOIN champion ch ON ch.champ_name_eng = rp.champ_name
),
-- 1차 매칭: 챔피언 + 팀 + 포지션
pk_match AS (
  SELECT mp.id AS mp_id, mp.custom_match_id, mp.player_code AS stored_player_code,
         rr.origin_player_code, rr.guild_id,
         COUNT(*) OVER (PARTITION BY mp.id) AS cand_cnt
  FROM match_participant mp
  JOIN raw_resolved rr
    ON rr.custom_match_id = mp.custom_match_id
   AND rr.champion_id = mp.champion_id
   AND rr.game_team = mp.game_team
   AND rr.position = mp.position
  WHERE mp.is_deleted = false
),
-- 2차 매칭(fallback): 챔피언명 매핑 실패분 — 팀+포지션 슬롯이 양쪽에서 유일할 때만
fb_match AS (
  SELECT mp.id AS mp_id, mp.custom_match_id, mp.player_code AS stored_player_code,
         rr.origin_player_code, rr.guild_id,
         COUNT(*) OVER (PARTITION BY mp.id) AS cand_cnt
  FROM match_participant mp
  JOIN raw_resolved rr
    ON rr.custom_match_id = mp.custom_match_id
   AND rr.game_team = mp.game_team
   AND rr.position = mp.position
  WHERE mp.is_deleted = false
    AND NOT EXISTS (SELECT 1 FROM pk_match pk WHERE pk.mp_id = mp.id)
    AND NOT EXISTS (
      SELECT 1 FROM match_participant mp2
      WHERE mp2.custom_match_id = mp.custom_match_id AND mp2.is_deleted = false
        AND mp2.game_team = mp.game_team AND mp2.position = mp.position AND mp2.id <> mp.id
    )
),
mapping AS (
  SELECT * FROM pk_match WHERE cand_cnt = 1
  UNION ALL
  SELECT * FROM fb_match WHERE cand_cnt = 1
)
SELECT mp_id, custom_match_id, guild_id, stored_player_code, origin_player_code
FROM mapping
WHERE origin_player_code IS NOT NULL
  AND stored_player_code <> origin_player_code;

-- ── 1. 사전 검증: 매핑이 mp 행당 정확히 1건인지 (아니면 전체 중단) ─────────
DO $$
DECLARE
  dup_cnt int;
BEGIN
  SELECT COUNT(*) INTO dup_cnt
  FROM (SELECT mp_id FROM tmp_mp_restore GROUP BY mp_id HAVING COUNT(*) > 1) d;
  IF dup_cnt > 0 THEN
    RAISE EXCEPTION '[TRC-243] 원복 중단: mp_id 중복 매핑 %건 — 매핑 로직 점검 필요', dup_cnt;
  END IF;
END $$;

-- ── 2. 원복 전 리포트: 무엇이 바뀌는지 ────────────────────────────────────
SELECT
  '(1) match_participant 원복 대상' AS report,
  COUNT(*)                          AS rows,
  COUNT(DISTINCT custom_match_id)   AS matches,
  COUNT(DISTINCT origin_player_code) AS origin_accounts
FROM tmp_mp_restore;

SELECT
  t.guild_id,
  o.riot_name || '#' || COALESCE(o.riot_name_tag, '') AS restore_to,
  s.riot_name || '#' || COALESCE(s.riot_name_tag, '') AS currently_stored_as,
  COUNT(*)                                            AS rows
FROM tmp_mp_restore t
JOIN riot_account o ON o.player_code = t.origin_player_code
JOIN riot_account s ON s.player_code = t.stored_player_code
GROUP BY t.guild_id, restore_to, currently_stored_as
ORDER BY rows DESC;

SELECT
  '(2) mmr_participant_metric 원복 대상' AS report,
  COUNT(*) FILTER (WHERE m.player_code IS NOT NULL
                     AND s.player_code IS NOT NULL) AS merged_rows,
  COUNT(*) FILTER (WHERE m.player_code IS NULL)     AS null_rows,
  COUNT(*) FILTER (WHERE m.player_code IS NOT NULL
                     AND s.player_code IS NULL)     AS dangling_rows
FROM mmr_participant_metric m
JOIN riot_account ra          ON ra.puuid = m.puuid
LEFT JOIN riot_account s      ON s.player_code = m.player_code
WHERE m.is_deleted = false
  AND m.player_code IS DISTINCT FROM ra.player_code;

-- ── 3. 원복 실행 ──────────────────────────────────────────────────────────
UPDATE match_participant mp
SET player_code = t.origin_player_code,
    update_date = now()
FROM tmp_mp_restore t
WHERE mp.id = t.mp_id;

UPDATE mmr_participant_metric m
SET player_code = ra.player_code,
    update_date = now()
FROM riot_account ra
WHERE ra.puuid = m.puuid
  AND m.is_deleted = false
  AND m.player_code IS DISTINCT FROM ra.player_code;

-- ── 4. 사후 검증: 원복 후 잔여 병합 0이어야 함 ────────────────────────────
SELECT
  '(3) 사후 검증 — 모두 0이어야 함' AS report,
  (SELECT COUNT(*)
     FROM match_participant mp
     JOIN tmp_mp_restore t ON t.mp_id = mp.id
    WHERE mp.player_code <> t.origin_player_code)  AS mp_still_merged,
  (SELECT COUNT(*)
     FROM mmr_participant_metric m
     JOIN riot_account ra ON ra.puuid = m.puuid
    WHERE m.is_deleted = false
      AND m.player_code IS DISTINCT FROM ra.player_code) AS metric_still_mismatched;

-- dry-run 시 아래 COMMIT을 ROLLBACK으로 바꿔 실행한다.
COMMIT;
