-- =============================================================================
-- backfill: mmr_participant_metric  ←  replay.raw_data
-- 기준 문서: docs/mmr/match_participant_metric_table_spec.md (raw 49 + 파생 14)
--           docs/mmr/steps/step01_migration.md §3.6 (우리 테이블 = 변환값 저장)
--
-- · 한 row = 한 경기의 한 참가자(player-game). 한 경기 = raw_data 배열 10원소.
-- · 원천: replay.raw_data (jsonb 배열). 값은 모두 문자열이라 ::int 캐스팅.
-- · categoricals는 우리 테이블 규격대로 "변환값" 저장:
--     game_team   : TEAM 100→blue, 200→red
--     position    : TEAM_POSITION JUNGLE→JUG, MIDDLE→MID, BOTTOM→ADC, UTILITY→SUP, TOP→TOP
--     game_result : WIN='Win'→1, 패배('Fail') 및 그 외→0  (raw값은 'Win'/'Fail')
-- · 파생지표: §3 산식대로 적재 시 계산, 소수 2자리 반올림, div0/NULL→0.
-- · is_mmr_eligible: step03 §3 기준(5분 이상 & AFK 아님)을 SQL로 재판정.
-- · 멱등: 이미 적재된 custom_match_id 는 건너뜀. is_deleted 리플은 제외.
-- =============================================================================

INSERT INTO mmr_participant_metric (
  custom_match_id, puuid, guild_id, season, champion_id, game_team, position, game_result, played_date,
  -- raw (정의서 §2.2)
  kills, deaths, assists, double_kills, triple_kills, quadra_kills, penta_kills,
  killing_sprees, largest_killing_spree, gold_earned, cc_time, game_duration,
  damage_to_champions, damage_taken, damage_self_mitigated, vision_score,
  wards_placed, wards_killed, detector_wards_placed, control_wards_bought,
  minions_killed, neutral_minions_killed, time_spent_dead, longest_time_living,
  damage_to_turrets, damage_to_objectives, dragon_kills, baron_kills, herald_kills, horde_kills,
  last_takedown_time, turrets_killed, turret_takedowns, level, exp,
  turret_plates_destroyed, takedowns_under_turret, takedowns_before_15min,
  jungle_cs_own, jungle_cs_enemy, damage_to_epic_monsters, objectives_stolen, barracks_killed,
  heal_on_teammates, shield_on_teammates,
  enemy_missing_pings, retreat_pings, on_my_way_pings, command_pings,
  -- 파생 (정의서 §2.3, §3)
  gold_per_min, dpm, damage_taken_per_min, cc_time_per_min, exp_per_min,
  damage_to_turrets_per_min, cs_per_min, wards_placed_per_min, wards_killed_per_min,
  kda, damage_taken_per_death, damage_dealt_per_death, dead_time_pct, lane_gold_diff,
  -- 파이프라인
  is_mmr_eligible, is_deleted
)
WITH base AS (
  -- 1) raw_data 배열을 참가자 단위로 펼치고, JSON 키 추출 + categoricals 변환
  SELECT
    r.replay_code                                         AS custom_match_id,
    r.guild_id,
    r.season,
    r.create_date                                         AS played_date,  -- raw에 게임 시각 없음 → 업로드 시각
    (p->>'PUUID')                                         AS puuid,
    (p->>'SKIN')                                          AS skin,
    CASE p->>'TEAM' WHEN '100' THEN 'blue' WHEN '200' THEN 'red' END  AS game_team,
    CASE p->>'TEAM_POSITION'
      WHEN 'TOP' THEN 'TOP' WHEN 'JUNGLE' THEN 'JUG' WHEN 'MIDDLE' THEN 'MID'
      WHEN 'BOTTOM' THEN 'ADC' WHEN 'UTILITY' THEN 'SUP' END          AS position,
    CASE WHEN p->>'WIN' = 'Win' THEN 1 ELSE 0 END                     AS game_result,
    (p->>'GAME_ENDED_IN_SURRENDER' = '1')                             AS ended_in_surrender,  -- is_mmr_eligible 판정용

    -- raw 정수 지표 (빈문자/누락 → NULL)
    NULLIF(p->>'CHAMPIONS_KILLED','')::int                AS kills,
    NULLIF(p->>'NUM_DEATHS','')::int                      AS deaths,
    NULLIF(p->>'ASSISTS','')::int                         AS assists,
    NULLIF(p->>'DOUBLE_KILLS','')::int                    AS double_kills,
    NULLIF(p->>'TRIPLE_KILLS','')::int                    AS triple_kills,
    NULLIF(p->>'QUADRA_KILLS','')::int                    AS quadra_kills,
    NULLIF(p->>'PENTA_KILLS','')::int                     AS penta_kills,
    NULLIF(p->>'KILLING_SPREES','')::int                  AS killing_sprees,
    NULLIF(p->>'LARGEST_KILLING_SPREE','')::int           AS largest_killing_spree,
    NULLIF(p->>'GOLD_EARNED','')::int                     AS gold_earned,
    NULLIF(p->>'TIME_CCING_OTHERS','')::int               AS cc_time,
    NULLIF(p->>'TIME_PLAYED','')::int                     AS game_duration,
    NULLIF(p->>'TOTAL_DAMAGE_DEALT_TO_CHAMPIONS','')::int AS damage_to_champions,
    NULLIF(p->>'TOTAL_DAMAGE_TAKEN','')::int              AS damage_taken,
    NULLIF(p->>'TOTAL_DAMAGE_SELF_MITIGATED','')::int     AS damage_self_mitigated,
    NULLIF(p->>'VISION_SCORE','')::int                    AS vision_score,
    NULLIF(p->>'WARD_PLACED','')::int                     AS wards_placed,
    NULLIF(p->>'WARD_KILLED','')::int                     AS wards_killed,
    NULLIF(p->>'WARD_PLACED_DETECTOR','')::int            AS detector_wards_placed,
    NULLIF(p->>'VISION_WARDS_BOUGHT_IN_GAME','')::int     AS control_wards_bought,
    NULLIF(p->>'MINIONS_KILLED','')::int                  AS minions_killed,
    NULLIF(p->>'NEUTRAL_MINIONS_KILLED','')::int          AS neutral_minions_killed,
    NULLIF(p->>'TOTAL_TIME_SPENT_DEAD','')::int           AS time_spent_dead,
    NULLIF(p->>'LONGEST_TIME_SPENT_LIVING','')::int       AS longest_time_living,
    NULLIF(p->>'TOTAL_DAMAGE_DEALT_TO_BUILDINGS','')::int AS damage_to_turrets,
    NULLIF(p->>'TOTAL_DAMAGE_DEALT_TO_OBJECTIVES','')::int AS damage_to_objectives,
    NULLIF(p->>'DRAGON_KILLS','')::int                    AS dragon_kills,
    NULLIF(p->>'BARON_KILLS','')::int                     AS baron_kills,
    NULLIF(p->>'RIFT_HERALD_KILLS','')::int               AS herald_kills,
    NULLIF(p->>'HORDE_KILLS','')::int                     AS horde_kills,
    NULLIF(p->>'LAST_TAKEDOWN_TIME','')::int              AS last_takedown_time,
    NULLIF(p->>'TURRETS_KILLED','')::int                  AS turrets_killed,
    NULLIF(p->>'TURRET_TAKEDOWNS','')::int                AS turret_takedowns,
    NULLIF(p->>'LEVEL','')::int                           AS level,
    NULLIF(p->>'EXP','')::int                             AS exp,
    NULLIF(p->>'Missions_TurretPlatesDestroyed','')::int  AS turret_plates_destroyed,
    NULLIF(p->>'Missions_TakedownsUnderTurret','')::int   AS takedowns_under_turret,
    NULLIF(p->>'Missions_TakedownsBefore15Min','')::int   AS takedowns_before_15min,
    NULLIF(p->>'NEUTRAL_MINIONS_KILLED_YOUR_JUNGLE','')::int  AS jungle_cs_own,
    NULLIF(p->>'NEUTRAL_MINIONS_KILLED_ENEMY_JUNGLE','')::int AS jungle_cs_enemy,
    NULLIF(p->>'TOTAL_DAMAGE_DEALT_TO_EPIC_MONSTERS','')::int AS damage_to_epic_monsters,
    NULLIF(p->>'OBJECTIVES_STOLEN','')::int               AS objectives_stolen,
    NULLIF(p->>'BARRACKS_KILLED','')::int                 AS barracks_killed,
    NULLIF(p->>'TOTAL_HEAL_ON_TEAMMATES','')::int         AS heal_on_teammates,
    NULLIF(p->>'TOTAL_DAMAGE_SHIELDED_ON_TEAMMATES','')::int AS shield_on_teammates,
    NULLIF(p->>'ENEMY_MISSING_PINGS','')::int             AS enemy_missing_pings,
    NULLIF(p->>'RETREAT_PINGS','')::int                   AS retreat_pings,
    NULLIF(p->>'ON_MY_WAY_PINGS','')::int                 AS on_my_way_pings,
    NULLIF(p->>'COMMAND_PINGS','')::int                   AS command_pings
  FROM replay r
  CROSS JOIN LATERAL jsonb_array_elements(r.raw_data) AS p
  WHERE r.is_deleted = false
    AND NOT EXISTS (                                       -- 멱등: 이미 backfill된 경기 skip
      SELECT 1 FROM mmr_participant_metric m WHERE m.custom_match_id = r.replay_code
    )
),
calc AS (
  -- 2) 파생 계산용 공통값 + lane 상대 골드(같은 경기·같은 포지션 윈도우)
  SELECT
    b.*,
    ROUND(b.game_duration::numeric / 60.0, 2)                                       AS minutes,
    CASE WHEN COALESCE(b.deaths,0) = 0 THEN 1 ELSE b.deaths END                     AS deaths_safe,
    SUM(b.gold_earned) OVER (PARTITION BY b.custom_match_id, b.position) - b.gold_earned AS opp_gold_sum,
    COUNT(*)           OVER (PARTITION BY b.custom_match_id, b.position) - 1         AS opp_count
  FROM base b
)
SELECT
  c.custom_match_id, c.puuid, c.guild_id, c.season, ch.id AS champion_id,
  c.game_team, c.position, c.game_result, c.played_date,
  -- raw
  c.kills, c.deaths, c.assists, c.double_kills, c.triple_kills, c.quadra_kills, c.penta_kills,
  c.killing_sprees, c.largest_killing_spree, c.gold_earned, c.cc_time, c.game_duration,
  c.damage_to_champions, c.damage_taken, c.damage_self_mitigated, c.vision_score,
  c.wards_placed, c.wards_killed, c.detector_wards_placed, c.control_wards_bought,
  c.minions_killed, c.neutral_minions_killed, c.time_spent_dead, c.longest_time_living,
  c.damage_to_turrets, c.damage_to_objectives, c.dragon_kills, c.baron_kills, c.herald_kills, c.horde_kills,
  c.last_takedown_time, c.turrets_killed, c.turret_takedowns, c.level, c.exp,
  c.turret_plates_destroyed, c.takedowns_under_turret, c.takedowns_before_15min,
  c.jungle_cs_own, c.jungle_cs_enemy, c.damage_to_epic_monsters, c.objectives_stolen, c.barracks_killed,
  c.heal_on_teammates, c.shield_on_teammates,
  c.enemy_missing_pings, c.retreat_pings, c.on_my_way_pings, c.command_pings,
  -- 파생 (per-min: stat / 분, div0/NULL→0, 2자리 반올림)
  COALESCE(ROUND(c.gold_earned::numeric          / NULLIF(c.minutes,0), 2), 0) AS gold_per_min,
  COALESCE(ROUND(c.damage_to_champions::numeric  / NULLIF(c.minutes,0), 2), 0) AS dpm,
  COALESCE(ROUND(c.damage_taken::numeric         / NULLIF(c.minutes,0), 2), 0) AS damage_taken_per_min,
  COALESCE(ROUND(c.cc_time::numeric              / NULLIF(c.minutes,0), 2), 0) AS cc_time_per_min,
  COALESCE(ROUND(c.exp::numeric                  / NULLIF(c.minutes,0), 2), 0) AS exp_per_min,
  COALESCE(ROUND(c.damage_to_turrets::numeric    / NULLIF(c.minutes,0), 2), 0) AS damage_to_turrets_per_min,
  COALESCE(ROUND((COALESCE(c.minions_killed,0) + COALESCE(c.neutral_minions_killed,0))::numeric
                                                 / NULLIF(c.minutes,0), 2), 0) AS cs_per_min,
  COALESCE(ROUND(c.wards_placed::numeric         / NULLIF(c.minutes,0), 2), 0) AS wards_placed_per_min,
  COALESCE(ROUND(c.wards_killed::numeric         / NULLIF(c.minutes,0), 2), 0) AS wards_killed_per_min,
  -- 파생 (per-death / 비율)
  COALESCE(ROUND((COALESCE(c.kills,0) + COALESCE(c.assists,0))::numeric / c.deaths_safe, 2), 0) AS kda,
  COALESCE(ROUND(c.damage_taken::numeric         / c.deaths_safe, 2), 0)       AS damage_taken_per_death,
  COALESCE(ROUND(c.damage_to_champions::numeric  / c.deaths_safe, 2), 0)       AS damage_dealt_per_death,
  COALESCE(ROUND(c.time_spent_dead::numeric / NULLIF(c.minutes * 60, 0) * 100, 2), 0) AS dead_time_pct,
  -- lane_gold_diff = 내 골드 - 같은 포지션 상대 평균 골드
  COALESCE(ROUND(c.gold_earned - (c.opp_gold_sum::numeric / NULLIF(c.opp_count,0)), 2), 0) AS lane_gold_diff,
  -- is_mmr_eligible (step03 §3: 5분 이상 & 15분 미만 항복 아님 & AFK 아님)
  (COALESCE(c.game_duration,0) >= 300
     AND NOT (c.ended_in_surrender AND COALESCE(c.game_duration,0) < 900)
     AND NOT (COALESCE(c.damage_to_champions,0) = 0 AND COALESCE(c.kills,0) + COALESCE(c.assists,0) = 0)) AS is_mmr_eligible,
  false AS is_deleted
FROM calc c
LEFT JOIN champion ch ON ch.champ_name_eng = c.skin;
