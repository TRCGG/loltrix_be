# mmr_participant_metric — 스키마 + 적재 구현 가이드 (자체완결)

> **이 문서 하나만 보고 구현 가능하도록 전부 인라인**(다른 docs 링크 의존 없음).
> 범위: (1) 테이블 DDL, (2) Drizzle 매핑, (3) 업로드 적재, (4) is_mmr_eligible 판정, (5) 파생 산식, (6) 기존경기 backfill SQL.
> 한 row = **한 경기의 한 참가자**(player-game). 정상 경기 = 10 row. 원천 = `replay.raw_data`(JSONB 배열).

---

## 1. 핵심 설계 (먼저 이것만)

- **구조**: raw 49 + 파생 14 + 식별/파이프라인.
- **값은 변환값 저장**(라이엇 원본값 아님):
  - `game_team`: `TEAM 100→blue, 200→red`
  - `position`: `TEAM_POSITION JUNGLE→JUG / MIDDLE→MID / BOTTOM→ADC / UTILITY→SUP / TOP→TOP`
  - `game_result`: `WIN='Win'→1, 'Fail'(패배) 등→0`
- **자연키 `(custom_match_id, puuid)`** — `match_participant_id`는 **저장 안 함**(raw_data만으로 backfill 가능하게). 필요 시 전송 단계에서 join.
- **raw·파생 컬럼은 nullable**(키 누락·구포맷 대응).
- **생성 범위 = 모든 길드**(구독 여부 무관). MMR 계산 대상 등록(`mmr_match_queue`)만 구독 길드.
- **업로드 적재와 backfill은 같은 결과**를 내야 한다(둘 다 raw_data 기준 동일 변환·산식).
- `custom_match_id` = `replay.replay_code`(= `custom_match.id`)와 동일 값.

---

## 2. 테이블 DDL

```sql
CREATE TABLE IF NOT EXISTS mmr_participant_metric (
  id                          BIGSERIAL PRIMARY KEY,
  -- 식별 / 메타
  custom_match_id             VARCHAR(255) NOT NULL,   -- = replay.replay_code
  puuid                       VARCHAR(128) NOT NULL,   -- rawData PUUID
  guild_id                    VARCHAR(128) NOT NULL,
  season                      VARCHAR(32)  NOT NULL,
  champion_id                 VARCHAR(16),             -- SKIN→champion.champ_name_eng (실패 시 NULL)
  game_team                   VARCHAR(8)   NOT NULL,   -- 변환값 blue/red
  position                    VARCHAR(8)   NOT NULL,   -- 변환값 TOP/JUG/MID/ADC/SUP
  game_result                 SMALLINT     NOT NULL,   -- 변환값 1/0
  played_date                 TIMESTAMPTZ  NOT NULL,   -- 업로드 시각(raw에 게임시각 없음), 처리 순서 ASC 기준
  -- raw 49 (JSON 키는 §4.2 매핑표)
  kills INTEGER, deaths INTEGER, assists INTEGER,
  double_kills INTEGER, triple_kills INTEGER, quadra_kills INTEGER, penta_kills INTEGER,
  killing_sprees INTEGER, largest_killing_spree INTEGER,
  gold_earned INTEGER, cc_time INTEGER, game_duration INTEGER,
  damage_to_champions INTEGER, damage_taken INTEGER, damage_self_mitigated INTEGER,
  vision_score INTEGER, wards_placed INTEGER, wards_killed INTEGER,
  detector_wards_placed INTEGER, control_wards_bought INTEGER,
  minions_killed INTEGER, neutral_minions_killed INTEGER,
  time_spent_dead INTEGER, longest_time_living INTEGER,
  damage_to_turrets INTEGER, damage_to_objectives INTEGER,
  dragon_kills INTEGER, baron_kills INTEGER, herald_kills INTEGER, horde_kills INTEGER,
  last_takedown_time INTEGER, turrets_killed INTEGER, turret_takedowns INTEGER,
  level INTEGER, exp INTEGER,
  turret_plates_destroyed INTEGER, takedowns_under_turret INTEGER, takedowns_before_15min INTEGER,
  jungle_cs_own INTEGER, jungle_cs_enemy INTEGER, damage_to_epic_monsters INTEGER,
  objectives_stolen INTEGER, barracks_killed INTEGER,
  heal_on_teammates INTEGER, shield_on_teammates INTEGER,
  enemy_missing_pings INTEGER, retreat_pings INTEGER, on_my_way_pings INTEGER, command_pings INTEGER,
  -- 파생 14 (§5 산식, 소수 2자리)
  gold_per_min NUMERIC, dpm NUMERIC, damage_taken_per_min NUMERIC, cc_time_per_min NUMERIC,
  exp_per_min NUMERIC, damage_to_turrets_per_min NUMERIC, cs_per_min NUMERIC,
  wards_placed_per_min NUMERIC, wards_killed_per_min NUMERIC,
  kda NUMERIC, damage_taken_per_death NUMERIC, damage_dealt_per_death NUMERIC,
  dead_time_pct NUMERIC, lane_gold_diff NUMERIC,
  -- 파이프라인
  is_mmr_eligible             BOOLEAN      NOT NULL DEFAULT TRUE,
  is_deleted                  BOOLEAN      NOT NULL DEFAULT FALSE,  -- 리플 삭제 시 soft delete
  create_date                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  update_date                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_mmr_participant_metric_match_puuid UNIQUE (custom_match_id, puuid)
);

CREATE INDEX IF NOT EXISTS idx_mpm_guild_season_played ON mmr_participant_metric (guild_id, season, played_date DESC);
CREATE INDEX IF NOT EXISTS idx_mpm_custom_match        ON mmr_participant_metric (custom_match_id);
CREATE INDEX IF NOT EXISTS idx_mpm_puuid_season        ON mmr_participant_metric (puuid, season);
```

---

## 3. Drizzle 매핑 (`schema.ts`)

`drizzle-orm/pg-core`에서 `pgTable, varchar, integer, smallint, numeric, boolean, timestamp, bigserial, unique, index` 필요. raw는 nullable `integer`, 파생은 nullable `numeric`.

```ts
// raw 지표: nullable INTEGER
const metricRaw = (name: string) => integer(name);

export const mmrParticipantMetric = pgTable(
  'mmr_participant_metric',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    customMatchId: varchar('custom_match_id', { length: 255 }).notNull(),
    puuid: varchar('puuid', { length: 128 }).notNull(),
    guildId: varchar('guild_id', { length: 128 }).notNull(),
    season: varchar('season', { length: 32 }).notNull(),
    championId: varchar('champion_id', { length: 16 }),
    gameTeam: varchar('game_team', { length: 8 }).notNull(),       // blue/red
    position: varchar('position', { length: 8 }).notNull(),        // TOP/JUG/MID/ADC/SUP
    gameResult: smallint('game_result').notNull(),                 // 1/0
    playedDate: timestamp('played_date', { withTimezone: true }).notNull(),
    // raw 49 (nullable)
    kills: metricRaw('kills'), deaths: metricRaw('deaths'), assists: metricRaw('assists'),
    doubleKills: metricRaw('double_kills'), tripleKills: metricRaw('triple_kills'),
    quadraKills: metricRaw('quadra_kills'), pentaKills: metricRaw('penta_kills'),
    killingSprees: metricRaw('killing_sprees'), largestKillingSpree: metricRaw('largest_killing_spree'),
    goldEarned: metricRaw('gold_earned'), ccTime: metricRaw('cc_time'), gameDuration: metricRaw('game_duration'),
    damageToChampions: metricRaw('damage_to_champions'), damageTaken: metricRaw('damage_taken'),
    damageSelfMitigated: metricRaw('damage_self_mitigated'),
    visionScore: metricRaw('vision_score'), wardsPlaced: metricRaw('wards_placed'), wardsKilled: metricRaw('wards_killed'),
    detectorWardsPlaced: metricRaw('detector_wards_placed'), controlWardsBought: metricRaw('control_wards_bought'),
    minionsKilled: metricRaw('minions_killed'), neutralMinionsKilled: metricRaw('neutral_minions_killed'),
    timeSpentDead: metricRaw('time_spent_dead'), longestTimeLiving: metricRaw('longest_time_living'),
    damageToTurrets: metricRaw('damage_to_turrets'), damageToObjectives: metricRaw('damage_to_objectives'),
    dragonKills: metricRaw('dragon_kills'), baronKills: metricRaw('baron_kills'),
    heraldKills: metricRaw('herald_kills'), hordeKills: metricRaw('horde_kills'),
    lastTakedownTime: metricRaw('last_takedown_time'), turretsKilled: metricRaw('turrets_killed'),
    turretTakedowns: metricRaw('turret_takedowns'), level: metricRaw('level'), exp: metricRaw('exp'),
    turretPlatesDestroyed: metricRaw('turret_plates_destroyed'),
    takedownsUnderTurret: metricRaw('takedowns_under_turret'), takedownsBefore15Min: metricRaw('takedowns_before_15min'),
    jungleCsOwn: metricRaw('jungle_cs_own'), jungleCsEnemy: metricRaw('jungle_cs_enemy'),
    damageToEpicMonsters: metricRaw('damage_to_epic_monsters'),
    objectivesStolen: metricRaw('objectives_stolen'), barracksKilled: metricRaw('barracks_killed'),
    healOnTeammates: metricRaw('heal_on_teammates'), shieldOnTeammates: metricRaw('shield_on_teammates'),
    enemyMissingPings: metricRaw('enemy_missing_pings'), retreatPings: metricRaw('retreat_pings'),
    onMyWayPings: metricRaw('on_my_way_pings'), commandPings: metricRaw('command_pings'),
    // 파생 14 (nullable NUMERIC) — Drizzle numeric은 string 추론
    goldPerMin: numeric('gold_per_min'), dpm: numeric('dpm'),
    damageTakenPerMin: numeric('damage_taken_per_min'), ccTimePerMin: numeric('cc_time_per_min'),
    expPerMin: numeric('exp_per_min'), damageToTurretsPerMin: numeric('damage_to_turrets_per_min'),
    csPerMin: numeric('cs_per_min'), wardsPlacedPerMin: numeric('wards_placed_per_min'),
    wardsKilledPerMin: numeric('wards_killed_per_min'), kda: numeric('kda'),
    damageTakenPerDeath: numeric('damage_taken_per_death'), damageDealtPerDeath: numeric('damage_dealt_per_death'),
    deadTimePct: numeric('dead_time_pct'), laneGoldDiff: numeric('lane_gold_diff'),
    // 파이프라인
    isMmrEligible: boolean('is_mmr_eligible').notNull().default(true),
    isDeleted: boolean('is_deleted').notNull().default(false),
    createDate: timestamp('create_date', { withTimezone: true }).notNull().defaultNow(),
    updateDate: timestamp('update_date', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    unique('uq_mmr_participant_metric_match_puuid').on(t.customMatchId, t.puuid),
    index('idx_mpm_guild_season_played').on(t.guildId, t.season, t.playedDate),
    index('idx_mpm_custom_match').on(t.customMatchId),
    index('idx_mpm_puuid_season').on(t.puuid, t.season),
  ],
);
export type MmrParticipantMetric = typeof mmrParticipantMetric.$inferSelect;
export type InsertMmrParticipantMetric = typeof mmrParticipantMetric.$inferInsert;
```

---

## 4. 업로드 적재

### 4.1 흐름 (facade hook)

업로드 저장 트랜잭션 끝에 metric을 적재한다. **metric은 모든 길드**, `mmr_match_queue` 등록만 구독 길드.

```
saveMatchData(rawData, savedReplay, tx):
  ... riotAccount / customMatch / matchParticipant / guildMember ...
  // 1) metric: 모든 길드
  const metricRows = buildMetricRows({
    rawData, matchParticipants,                 // insert된 match_participant (순서 = rawData 순서)
    customMatchId: customMatch.id, guildId: savedReplay.guildId, season: savedReplay.season,
    playedDate: customMatch.createDate,         // raw에 게임시각 없음 → 업로드 시각
  });
  await insertMetrics(metricRows, tx);
  // 2) 구독 active 길드만 큐 등록
  if (await isMmrActive(savedReplay.guildId, tx)) {
    const eligible = isMatchEligibleForMmr(metricRows);
    await mmrMatchQueue.insertInitialStatus(
      { customMatchId: customMatch.id, guildId, season, status: eligible ? 'wait' : 'skip' }, tx);
  }
```

> `match_participant`는 이미 라이엇값을 우리값으로 매핑(blue/red, position enum, 승/패, championId)해 둔다.
> 그 변환값을 categoricals/championId에 **재사용**하고, 나머지 raw 49개는 rawData에서 직접 뽑는다(매퍼 중복 방지, backfill의 CASE와 동일 결과).

### 4.2 raw 49 키 매핑 (전체)

```ts
const toIntOrNull = (v?: string | null) => { const n = parseInt(v ?? '', 10); return Number.isNaN(n) ? null : n; };

// metric 컬럼(camelCase) ← rawData JSON 키.  ⚠️ WARD_PLACED/WARD_KILLED 는 단수형!
const RAW_KEY_MAP = {
  kills: 'CHAMPIONS_KILLED', deaths: 'NUM_DEATHS', assists: 'ASSISTS',
  doubleKills: 'DOUBLE_KILLS', tripleKills: 'TRIPLE_KILLS', quadraKills: 'QUADRA_KILLS', pentaKills: 'PENTA_KILLS',
  killingSprees: 'KILLING_SPREES', largestKillingSpree: 'LARGEST_KILLING_SPREE',
  goldEarned: 'GOLD_EARNED', ccTime: 'TIME_CCING_OTHERS', gameDuration: 'TIME_PLAYED',
  damageToChampions: 'TOTAL_DAMAGE_DEALT_TO_CHAMPIONS', damageTaken: 'TOTAL_DAMAGE_TAKEN',
  damageSelfMitigated: 'TOTAL_DAMAGE_SELF_MITIGATED',
  visionScore: 'VISION_SCORE', wardsPlaced: 'WARD_PLACED', wardsKilled: 'WARD_KILLED',
  detectorWardsPlaced: 'WARD_PLACED_DETECTOR', controlWardsBought: 'VISION_WARDS_BOUGHT_IN_GAME',
  minionsKilled: 'MINIONS_KILLED', neutralMinionsKilled: 'NEUTRAL_MINIONS_KILLED',
  timeSpentDead: 'TOTAL_TIME_SPENT_DEAD', longestTimeLiving: 'LONGEST_TIME_SPENT_LIVING',
  damageToTurrets: 'TOTAL_DAMAGE_DEALT_TO_BUILDINGS', damageToObjectives: 'TOTAL_DAMAGE_DEALT_TO_OBJECTIVES',
  dragonKills: 'DRAGON_KILLS', baronKills: 'BARON_KILLS', heraldKills: 'RIFT_HERALD_KILLS', hordeKills: 'HORDE_KILLS',
  lastTakedownTime: 'LAST_TAKEDOWN_TIME', turretsKilled: 'TURRETS_KILLED', turretTakedowns: 'TURRET_TAKEDOWNS',
  level: 'LEVEL', exp: 'EXP',
  turretPlatesDestroyed: 'Missions_TurretPlatesDestroyed',
  takedownsUnderTurret: 'Missions_TakedownsUnderTurret', takedownsBefore15Min: 'Missions_TakedownsBefore15Min',
  jungleCsOwn: 'NEUTRAL_MINIONS_KILLED_YOUR_JUNGLE', jungleCsEnemy: 'NEUTRAL_MINIONS_KILLED_ENEMY_JUNGLE',
  damageToEpicMonsters: 'TOTAL_DAMAGE_DEALT_TO_EPIC_MONSTERS',
  objectivesStolen: 'OBJECTIVES_STOLEN', barracksKilled: 'BARRACKS_KILLED',
  healOnTeammates: 'TOTAL_HEAL_ON_TEAMMATES', shieldOnTeammates: 'TOTAL_DAMAGE_SHIELDED_ON_TEAMMATES',
  enemyMissingPings: 'ENEMY_MISSING_PINGS', retreatPings: 'RETREAT_PINGS',
  onMyWayPings: 'ON_MY_WAY_PINGS', commandPings: 'COMMAND_PINGS',
} as const;  // ← 49개
```

### 4.3 buildMetricRows

```ts
buildMetricRows(input): InsertMmrParticipantMetric[] {
  const { rawData, matchParticipants, customMatchId, guildId, season, playedDate } = input;
  if (rawData.length !== matchParticipants.length) throw new Error('metric build mismatch: length');

  const rows = matchParticipants.map((mp, i) => {
    const p = rawData[i] as Record<string, string | undefined>;
    if (!p.PUUID) throw new Error('metric build mismatch: PUUID alignment');
    const raw = Object.fromEntries(
      Object.entries(RAW_KEY_MAP).map(([col, key]) => [col, toIntOrNull(p[key])]),
    );
    return {
      customMatchId, guildId, season, puuid: p.PUUID, playedDate,
      championId: mp.championId,                          // 변환값 재사용
      gameTeam: mp.gameTeam,                              // blue/red
      position: mp.position,                             // enum
      gameResult: mp.gameResult === '승' ? 1 : 0,         // (mp가 '승'/'패'로 매핑돼 있을 때)
      ...raw,
      isMmrEligible: judgeIsMmrEligible({
        timePlayed: raw.gameDuration ?? 0, totalDamageChampions: raw.damageToChampions ?? 0,
        kill: raw.kills ?? 0, assist: raw.assists ?? 0,
        endedInSurrender: p.GAME_ENDED_IN_SURRENDER === '1',  // metric엔 저장 안 함, 판정용
      }),
    };
  });
  return addDerivedMetrics(rows);   // §5
}

async insertMetrics(rows, tx) {
  if (rows.length === 0) return [];
  return tx.insert(mmrParticipantMetric).values(rows).returning();
}
```

> categoricals를 `match_participant`가 아니라 rawData에서 직접 변환하고 싶으면:
> `gameTeam = p.TEAM==='100'?'blue':'red'`, `position = {TOP:'TOP',JUNGLE:'JUG',MIDDLE:'MID',BOTTOM:'ADC',UTILITY:'SUP'}[p.TEAM_POSITION]`,
> `gameResult = p.WIN==='Win'?1:0`, `championId = champion(champ_name_eng=p.SKIN)`. (backfill SQL과 동일 규칙)

---

## 5. is_mmr_eligible 판정 + 파생 산식

### 5.1 per-row 적격 (`judgeIsMmrEligible`)

```ts
const MIN_TIME_PLAYED_SECONDS = 300;   // 5분 미만 제외
const SURRENDER_MIN_SECONDS  = 900;    // 15분 미만 '항복' 경기 제외

judgeIsMmrEligible(a: { timePlayed; totalDamageChampions; kill; assist; endedInSurrender: boolean }): boolean {
  if (a.timePlayed < MIN_TIME_PLAYED_SECONDS) return false;
  if (a.endedInSurrender && a.timePlayed < SURRENDER_MIN_SECONDS) return false;   // 15분 미만 항복
  if (a.totalDamageChampions === 0 && a.kill + a.assist === 0) return false;      // AFK 의심
  return true;
}
```

### 5.2 경기 단위 적격 (`isMatchEligibleForMmr`) → queue status 결정

```ts
const POSITIONS = ['TOP','JUG','MID','ADC','SUP'] as const;
isMatchEligibleForMmr(rows): boolean {
  if (rows.length !== 10) return false;
  if (!rows.every(r => r.isMmrEligible !== false)) return false;   // 1명이라도 false → skip
  const c = new Map<string, number>();
  for (const r of rows) c.set(r.position, (c.get(r.position) ?? 0) + 1);
  return POSITIONS.every(p => c.get(p) === 2);                     // 5포지션 각 2명
}
// true → mmr_match_queue 'wait', false → 'skip' (구독 길드만 등록)
```

### 5.3 파생 14개 산식 (`addDerivedMetrics`) — backfill과 **수치 정확 일치 필수**

```text
분(minutes) = ROUND(game_duration / 60.0, 2)        # game_duration = TIME_PLAYED(초)
deaths_safe = (deaths = 0) ? 1 : deaths
모든 결과    = ROUND(결과, 2),  분모 0/NULL·inf·NaN → 0
```
| 컬럼 | 식 |
|---|---|
| gold_per_min | gold_earned / 분 |
| dpm | damage_to_champions / 분 |
| damage_taken_per_min | damage_taken / 분 |
| cc_time_per_min | cc_time / 분 |
| exp_per_min | exp / 분 |
| damage_to_turrets_per_min | damage_to_turrets / 분 |
| cs_per_min | (minions_killed + neutral_minions_killed) / 분 |
| wards_placed_per_min | wards_placed / 분 |
| wards_killed_per_min | wards_killed / 분 |
| kda | (kills + assists) / deaths_safe |
| damage_taken_per_death | damage_taken / deaths_safe |
| damage_dealt_per_death | damage_to_champions / deaths_safe |
| dead_time_pct | time_spent_dead / (분 * 60) * 100 |
| lane_gold_diff | gold_earned − (같은 경기·같은 position 상대들의 평균 gold_earned) |

> `lane_gold_diff`: 업로드는 메모리의 10행을 position별 그룹(정상 5v5면 그룹당 2명)으로 묶어 "상대 평균과의 차". backfill은 윈도우로 같은 정의.

---

## 6. 기존 경기 backfill (일회성 SQL)

배포 이전 업로드된 경기는 metric이 없다. 아래 SQL을 **한 번** 실행(멱등: 이미 적재된 경기 skip).

```sql
INSERT INTO mmr_participant_metric (
  custom_match_id, puuid, guild_id, season, champion_id, game_team, position, game_result, played_date,
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
    r.guild_id, r.season,
    r.create_date                                         AS played_date,
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
  c.custom_match_id, c.puuid, c.guild_id, c.season, ch.id AS champion_id,
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
LEFT JOIN champion ch ON ch.champ_name_eng = c.skin;
```

---

## 7. 주의점 / gotcha (실데이터 검증됨)

| 항목 | 내용 |
|---|---|
| **와드 키** | `WARD_PLACED` / `WARD_KILLED` **단수형** (복수형 아님) |
| **WIN 값** | `'Win'` / **`'Fail'`**(패배). `game_result = (WIN='Win')?1:0` |
| **TEAM** | `'100'`/`'200'` → blue/red |
| **TEAM_POSITION** | TOP/JUNGLE/MIDDLE/BOTTOM/UTILITY → enum. 정상 경기 5포지션 × 2명 |
| **SKIN** | 영문 챔프명 → `champion.champ_name_eng` 매핑. 실패 시 champion_id NULL |
| **값 타입** | raw_data 값은 전부 **문자열**(`"168"`) → parseInt / `::int` |
| **played_date** | raw에 게임시각 없음 → 업로드 시각(custom_match.create_date) |
| **항복 제외** | `GAME_ENDED_IN_SURRENDER='1' AND game_duration<900`만 제외 (15분 이후·정상 종료 무관) |
| **match_participant_id 미저장** | 자연키 `(custom_match_id, puuid)`. gmok 전송 단계에서 join으로 부착 |
| **업로드 ↔ backfill 일치** | 변환·파생 산식이 동일 결과여야 함 (안 그러면 RECALC와 incremental 불일치) |
| **numeric 추론** | Drizzle `numeric`은 string. 파생값 insert/조회 시 변환 일관성 주의 |

---

## 8. 체크리스트

- [ ] `mmr_participant_metric` 테이블 + 3 인덱스 생성 (§2)
- [ ] Drizzle `mmrParticipantMetric` + 타입 (§3)
- [ ] `buildMetricRows`(49 raw + 변환 + 파생) + `insertMetrics` (§4)
- [ ] `judgeIsMmrEligible`(5분·15분 항복·AFK) + `isMatchEligibleForMmr`(10명·5×2) (§5)
- [ ] facade hook: 모든 길드 metric, 구독 길드만 queue (§4.1)
- [ ] 업로드 결과가 backfill SQL 결과와 수치 일치
- [ ] (선택) 기존 경기 backfill SQL 1회 실행 (§6)
