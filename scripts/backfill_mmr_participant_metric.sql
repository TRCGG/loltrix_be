-- ════════════════════════════════════════════════════════════════════════
-- mmr_participant_metric 기존 경기 backfill (일회성)
-- ════════════════════════════════════════════════════════════════════════
-- 배포 이전 업로드된 경기는 metric이 없다. 이 SQL을 한 번 실행해 채운다.
--   - 멱등: 이미 적재된 경기(custom_match_id 존재)는 NOT EXISTS로 skip → 재실행 안전
--   - 적재 서비스(src/services/mmrMetric.service.ts)와 변환·파생 산식이 동일 결과를 내야 한다.
--     (championId LEFT JOIN, 파생 ROUND(...,2)·분모 0→0, 항복 판정 일치)
-- 선행 조건: migrations/006_add_mmr_participant_metric.sql 적용 완료.
-- 주의: 데이터량이 많으면 시간이 오래 걸릴 수 있다. 운영에선 트랜잭션/배치 고려.
-- ════════════════════════════════════════════════════════════════════════

INSERT INTO mmr_participant_metric (
  custom_match_id, puuid, player_code, guild_id, season, champion_id, game_team, position, game_result, played_date,
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
  gold_per_min, dpm, damage_taken_per_min, cc_time_per_min, exp_per_min,
  damage_to_turrets_per_min, cs_per_min, wards_placed_per_min, wards_killed_per_min,
  kda, damage_taken_per_death, damage_dealt_per_death, dead_time_pct, lane_gold_diff,
  is_mmr_eligible, is_deleted
)
WITH base AS (
  SELECT
    r.replay_code                                         AS custom_match_id,
    -- guild_id·season·played_date는 custom_match 기준(canonical). replay는 guild id 이관 시 stale 가능.
    cm.guild_id, cm.season,
    cm.create_date                                        AS played_date,
    (p->>'PUUID')                                         AS puuid,
    (p->>'SKIN')                                          AS skin,
    CASE p->>'TEAM' WHEN '100' THEN 'blue' WHEN '200' THEN 'red' END  AS game_team,
    CASE p->>'TEAM_POSITION'
      WHEN 'TOP' THEN 'TOP' WHEN 'JUNGLE' THEN 'JUG' WHEN 'MIDDLE' THEN 'MID'
      WHEN 'BOTTOM' THEN 'ADC' WHEN 'UTILITY' THEN 'SUP' END          AS position,
    CASE WHEN p->>'WIN' = 'Win' THEN 1 ELSE 0 END                     AS game_result,
    (p->>'GAME_ENDED_IN_SURRENDER' = '1')                            AS ended_in_surrender,
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
  JOIN custom_match cm ON cm.id = r.replay_code AND cm.is_deleted = false
  CROSS JOIN LATERAL jsonb_array_elements(r.raw_data) AS p
  WHERE r.is_deleted = false
    AND NOT EXISTS (SELECT 1 FROM mmr_participant_metric m WHERE m.custom_match_id = r.replay_code)
),
calc AS (
  SELECT b.*,
    ROUND(b.game_duration::numeric / 60.0, 2)                                       AS minutes,
    CASE WHEN COALESCE(b.deaths,0) = 0 THEN 1 ELSE b.deaths END                     AS deaths_safe,
    SUM(b.gold_earned) OVER (PARTITION BY b.custom_match_id, b.position) - b.gold_earned AS opp_gold_sum,
    COUNT(*)           OVER (PARTITION BY b.custom_match_id, b.position) - 1         AS opp_count
  FROM base b
)
SELECT
  c.custom_match_id, c.puuid,
  -- 본계정 병합 player_code: 해당 길드에서 부계정이면 main_account, 아니면 본인 playerCode
  CASE WHEN gm.is_main = false THEN gm.main_account ELSE ra.player_code END AS player_code,
  c.guild_id, c.season, ch.id AS champion_id,
  c.game_team, c.position, c.game_result, c.played_date,
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
  COALESCE(ROUND(c.gold_earned::numeric         / NULLIF(c.minutes,0), 2), 0) AS gold_per_min,
  COALESCE(ROUND(c.damage_to_champions::numeric / NULLIF(c.minutes,0), 2), 0) AS dpm,
  COALESCE(ROUND(c.damage_taken::numeric        / NULLIF(c.minutes,0), 2), 0) AS damage_taken_per_min,
  COALESCE(ROUND(c.cc_time::numeric             / NULLIF(c.minutes,0), 2), 0) AS cc_time_per_min,
  COALESCE(ROUND(c.exp::numeric                 / NULLIF(c.minutes,0), 2), 0) AS exp_per_min,
  COALESCE(ROUND(c.damage_to_turrets::numeric   / NULLIF(c.minutes,0), 2), 0) AS damage_to_turrets_per_min,
  COALESCE(ROUND((COALESCE(c.minions_killed,0) + COALESCE(c.neutral_minions_killed,0))::numeric
                                                / NULLIF(c.minutes,0), 2), 0) AS cs_per_min,
  COALESCE(ROUND(c.wards_placed::numeric        / NULLIF(c.minutes,0), 2), 0) AS wards_placed_per_min,
  COALESCE(ROUND(c.wards_killed::numeric        / NULLIF(c.minutes,0), 2), 0) AS wards_killed_per_min,
  COALESCE(ROUND((COALESCE(c.kills,0) + COALESCE(c.assists,0))::numeric / c.deaths_safe, 2), 0) AS kda,
  COALESCE(ROUND(c.damage_taken::numeric        / c.deaths_safe, 2), 0)       AS damage_taken_per_death,
  COALESCE(ROUND(c.damage_to_champions::numeric / c.deaths_safe, 2), 0)       AS damage_dealt_per_death,
  COALESCE(ROUND(c.time_spent_dead::numeric / NULLIF(c.minutes * 60, 0) * 100, 2), 0) AS dead_time_pct,
  COALESCE(ROUND(c.gold_earned - (c.opp_gold_sum::numeric / NULLIF(c.opp_count,0)), 2), 0) AS lane_gold_diff,
  (COALESCE(c.game_duration,0) >= 300
     AND NOT (c.ended_in_surrender AND COALESCE(c.game_duration,0) < 900)
     AND NOT (COALESCE(c.damage_to_champions,0) = 0 AND COALESCE(c.kills,0) + COALESCE(c.assists,0) = 0)) AS is_mmr_eligible,
  false AS is_deleted
FROM calc c
LEFT JOIN champion ch ON ch.champ_name_eng = c.skin
-- player_code 병합용 조인 (puuid → 본인 playerCode → 길드 본계정)
LEFT JOIN riot_account ra ON ra.puuid = c.puuid
LEFT JOIN guild_member gm
  ON gm.account = ra.player_code
 AND gm.guild_id = c.guild_id
 AND gm.is_deleted = false;
