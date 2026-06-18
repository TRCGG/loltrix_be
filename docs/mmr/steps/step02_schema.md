# step02 — Drizzle ORM 스키마

> 상위 문서: [02_data_model.md](../02_data_model.md) | 선행: [step01_migration.md](./step01_migration.md)
> 다음 step: [step03_metric_eligible.md](./step03_metric_eligible.md)

---

## 1. 목적 / 범위

[step01](./step01_migration.md)의 9테이블 DDL을 **Drizzle ORM 정의로 1:1 매핑**한다. 타입 추론(`$inferSelect`/`$inferInsert`)으로 서비스 계층이 타입 안전하게 쓰도록 한다.

- DDL이 SoT다. 이 step은 그 DDL과 **정확히 일치**하는 Drizzle 정의를 만든다.
- 마이그레이션 실행(테이블 생성)은 step01의 raw SQL이 담당한다. Drizzle은 **쿼리·타입용 매핑**만 한다(`drizzle-kit push`로 테이블을 만들지 않는다 — 파티션·partial index를 raw SQL로 관리하기 때문).

### 산출물

| 파일 | 내용 |
|---|---|
| `src/database/schema.ts` | 아래 §3의 9개 `pgTable` 정의 + 타입 export 추가 (기존 파일에 append) |

---

## 2. 매핑 규칙 (DDL → Drizzle)

| DDL | Drizzle |
|---|---|
| `SERIAL PRIMARY KEY` | `serial('id').primaryKey()` |
| `BIGSERIAL PRIMARY KEY` | `bigserial('id', { mode: 'number' }).primaryKey()` |
| `VARCHAR(n)` | `varchar('col', { length: n })` |
| `TIMESTAMPTZ` | `timestamp('col', { withTimezone: true })` |
| `JSONB` | `jsonb('col')` |
| `NUMERIC(6,4)` | `numeric('col', { precision: 6, scale: 4 })` |
| `SMALLINT` | `smallint('col')` |
| `... DEFAULT NOW()` | `.defaultNow()` |
| `update_date` 자동 갱신 | `.$onUpdate(() => new Date())` |
| `UNIQUE(a, b)` | `unique('uq_name').on(t.a, t.b)` |
| `UNIQUE INDEX ... WHERE` | `uniqueIndex('uq_name').on(t.col).where(sql\`...\`)` |
| `INDEX ... WHERE` | `index('idx_name').on(...).where(sql\`...\`)` |
| 복합 PK | `primaryKey({ name, columns: [...] })` |
| FK | `.references(() => other.col)` |

**FK는 step01과 동일하게 최소만**: `mmr_match_queue.custom_match_id → custom_match.id` 하나뿐. `mmr_participant_metric`은 **FK 없음**(자연키 `(custom_match_id, puuid)`, raw_data 파싱 기반이라 `match_participant_id` 미보유). MMR 테이블 상호간 FK도 걸지 않는다(`mmr_history.mmr_match_result_id`도 컬럼만, FK 제약 X).

---

## 3. 스키마 정의

> import 추가 (`drizzle-orm/pg-core`): `serial, bigserial, bigint, smallint, numeric, index, uniqueIndex, primaryKey`. (기존에 `pgTable/varchar/timestamp/jsonb/boolean/integer/text/unique`와 `sql`은 이미 있음.) PK는 step01 DDL의 `SERIAL`/`BIGSERIAL`과 맞춰 `serial`/`bigserial`을 쓴다. 기존 테이블 `guild`·`customMatch`·`matchParticipant`는 같은 파일에서 참조.

### 3.1 guild_subscription

```ts
export const guildSubscription = pgTable(
  'guild_subscription',
  {
    id: serial('id').primaryKey(),
    guildId: varchar('guild_id', { length: 128 }).notNull().references(() => guild.id),
    serviceKey: varchar('service_key', { length: 32 }).notNull(),
    status: varchar('status', { length: 16 }).notNull(),          // active / cancelled
    enabledDate: timestamp('enabled_date', { withTimezone: true }).notNull().defaultNow(),
    endedDate: timestamp('ended_date', { withTimezone: true }),
    createDate: timestamp('create_date', { withTimezone: true }).notNull().defaultNow(),
    updateDate: timestamp('update_date', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [unique('uq_guild_subscription_guild_service').on(t.guildId, t.serviceKey)],
);
export type GuildSubscription = typeof guildSubscription.$inferSelect;
export type InsertGuildSubscription = typeof guildSubscription.$inferInsert;
```

### 3.2 mmr_guild_state

```ts
export const mmrGuildState = pgTable(
  'mmr_guild_state',
  {
    id: serial('id').primaryKey(),
    guildId: varchar('guild_id', { length: 128 }).notNull(),
    season: varchar('season', { length: 32 }).notNull(),
    status: varchar('status', { length: 16 }).notNull(),          // wait_init / ready / error
    errorMessage: text('error_message'),
    createDate: timestamp('create_date', { withTimezone: true }).notNull().defaultNow(),
    updateDate: timestamp('update_date', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [unique('uq_mmr_guild_state_guild_season').on(t.guildId, t.season)],
);
export type MmrGuildState = typeof mmrGuildState.$inferSelect;
export type InsertMmrGuildState = typeof mmrGuildState.$inferInsert;
```

### 3.3 mmr_season_baseline

```ts
export const mmrSeasonBaseline = pgTable(
  'mmr_season_baseline',
  {
    id: serial('id').primaryKey(),
    season: varchar('season', { length: 32 }).notNull(),
    baselineVersion: varchar('baseline_version', { length: 32 }).notNull(),
    mmrBaseline: jsonb('mmr_baseline').notNull(),
    gameImpactBaseline: jsonb('game_impact_baseline').notNull(),
    metadata: jsonb('metadata').notNull().default({}),            // { match_count, row_count }
    isActive: boolean('is_active').notNull().default(false),
    createDate: timestamp('create_date', { withTimezone: true }).notNull().defaultNow(),
    updateDate: timestamp('update_date', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    unique('uq_mmr_season_baseline_season_version').on(t.season, t.baselineVersion),
    uniqueIndex('uq_mmr_season_baseline_active_per_season').on(t.season).where(sql`is_active = TRUE`),
  ],
);
export type MmrSeasonBaseline = typeof mmrSeasonBaseline.$inferSelect;
export type InsertMmrSeasonBaseline = typeof mmrSeasonBaseline.$inferInsert;
```

### 3.4 mmr_job

```ts
export const mmrJob = pgTable(
  'mmr_job',
  {
    id: serial('id').primaryKey(),
    guildId: varchar('guild_id', { length: 128 }),
    season: varchar('season', { length: 32 }),
    jobType: varchar('job_type', { length: 32 }).notNull(),       // INCREMENTAL_BATCH / RECALC / CLEANUP
    status: varchar('status', { length: 16 }).notNull(),          // wait / run / done / fail / cancel
    attempts: integer('attempts').notNull().default(0),
    scheduledDate: timestamp('scheduled_date', { withTimezone: true }).notNull().defaultNow(),
    startedDate: timestamp('started_date', { withTimezone: true }),
    finishedDate: timestamp('finished_date', { withTimezone: true }),
    errorMessage: text('error_message'),
    createDate: timestamp('create_date', { withTimezone: true }).notNull().defaultNow(),
    updateDate: timestamp('update_date', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    index('idx_mmr_job_status_scheduled').on(t.status, t.scheduledDate).where(sql`status IN ('wait', 'run')`),
    index('idx_mmr_job_guild_type_status').on(t.guildId, t.jobType, t.status),
  ],
);
export type MmrJob = typeof mmrJob.$inferSelect;
export type InsertMmrJob = typeof mmrJob.$inferInsert;
```

### 3.5 mmr_match_queue

```ts
export const mmrMatchQueue = pgTable(
  'mmr_match_queue',
  {
    customMatchId: varchar('custom_match_id', { length: 255 }).primaryKey().references(() => customMatch.id),
    guildId: varchar('guild_id', { length: 128 }).notNull(),
    season: varchar('season', { length: 32 }).notNull(),
    status: varchar('status', { length: 16 }).notNull(),          // wait / done / fail / skip
    errorMessage: text('error_message'),
    isDeleted: boolean('is_deleted').notNull().default(false),    // 리플 삭제 soft delete
    createDate: timestamp('create_date', { withTimezone: true }).notNull().defaultNow(),  // 60분 딜레이 기준
    updateDate: timestamp('update_date', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [index('idx_mmr_match_queue_guild_season_status').on(t.guildId, t.season, t.status, t.createDate)],
);
export type MmrMatchQueue = typeof mmrMatchQueue.$inferSelect;
export type InsertMmrMatchQueue = typeof mmrMatchQueue.$inferInsert;
```

### 3.6 mmr_participant_metric

> ⚠️ **dev에 이미 있음** — `src/database/schema.ts`의 `mmrParticipantMetric`(마이그레이션 007, 상대전적). **재작성 말고 재사용.** dev 버전엔 상대전적용 `player_code`(+ `idx_mpm_guild_player`)가 추가돼 있다(MMR은 미사용). 아래 매핑은 참고용.

> 구조 기준: [match_participant_metric_table_spec.md](../match_participant_metric_table_spec.md) (raw 49 + 파생 14). categoricals는 **변환값** 저장(`game_team`/`position` enum/`game_result`). raw·파생은 nullable.

```ts
const num = (name: string) => integer(name);  // raw 지표: nullable INTEGER

export const mmrParticipantMetric = pgTable(
  'mmr_participant_metric',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    // 식별 / 메타
    customMatchId: varchar('custom_match_id', { length: 255 }).notNull(),   // = replay.replay_code
    puuid: varchar('puuid', { length: 128 }).notNull(),
    guildId: varchar('guild_id', { length: 128 }).notNull(),
    season: varchar('season', { length: 32 }).notNull(),
    championId: varchar('champion_id', { length: 16 }),                     // 매핑 실패 시 NULL
    gameTeam: varchar('game_team', { length: 8 }).notNull(),                // 변환값 blue/red
    position: varchar('position', { length: 8 }).notNull(),                 // 변환값 TOP/JUG/MID/ADC/SUP
    gameResult: smallint('game_result').notNull(),                          // 변환값 1/0
    playedDate: timestamp('played_date', { withTimezone: true }).notNull(),
    // raw 지표 (nullable, JSON 키 파싱)
    kills: num('kills'), deaths: num('deaths'), assists: num('assists'),
    doubleKills: num('double_kills'), tripleKills: num('triple_kills'),
    quadraKills: num('quadra_kills'), pentaKills: num('penta_kills'),
    killingSprees: num('killing_sprees'), largestKillingSpree: num('largest_killing_spree'),
    goldEarned: num('gold_earned'), ccTime: num('cc_time'), gameDuration: num('game_duration'),
    damageToChampions: num('damage_to_champions'), damageTaken: num('damage_taken'),
    damageSelfMitigated: num('damage_self_mitigated'),
    visionScore: num('vision_score'), wardsPlaced: num('wards_placed'), wardsKilled: num('wards_killed'),
    detectorWardsPlaced: num('detector_wards_placed'), controlWardsBought: num('control_wards_bought'),
    minionsKilled: num('minions_killed'), neutralMinionsKilled: num('neutral_minions_killed'),
    timeSpentDead: num('time_spent_dead'), longestTimeLiving: num('longest_time_living'),
    damageToTurrets: num('damage_to_turrets'), damageToObjectives: num('damage_to_objectives'),
    dragonKills: num('dragon_kills'), baronKills: num('baron_kills'),
    heraldKills: num('herald_kills'), hordeKills: num('horde_kills'),
    lastTakedownTime: num('last_takedown_time'), turretsKilled: num('turrets_killed'),
    turretTakedowns: num('turret_takedowns'), level: num('level'), exp: num('exp'),
    turretPlatesDestroyed: num('turret_plates_destroyed'),
    takedownsUnderTurret: num('takedowns_under_turret'), takedownsBefore15Min: num('takedowns_before_15min'),
    jungleCsOwn: num('jungle_cs_own'), jungleCsEnemy: num('jungle_cs_enemy'),
    damageToEpicMonsters: num('damage_to_epic_monsters'),
    objectivesStolen: num('objectives_stolen'), barracksKilled: num('barracks_killed'),
    healOnTeammates: num('heal_on_teammates'), shieldOnTeammates: num('shield_on_teammates'),
    enemyMissingPings: num('enemy_missing_pings'), retreatPings: num('retreat_pings'),
    onMyWayPings: num('on_my_way_pings'), commandPings: num('command_pings'),
    // 파생 지표 (nullable NUMERIC, 소수 2자리)
    goldPerMin: numeric('gold_per_min'), dpm: numeric('dpm'),
    damageTakenPerMin: numeric('damage_taken_per_min'), ccTimePerMin: numeric('cc_time_per_min'),
    expPerMin: numeric('exp_per_min'), damageToTurretsPerMin: numeric('damage_to_turrets_per_min'),
    csPerMin: numeric('cs_per_min'), wardsPlacedPerMin: numeric('wards_placed_per_min'),
    wardsKilledPerMin: numeric('wards_killed_per_min'), kda: numeric('kda'),
    damageTakenPerDeath: numeric('damage_taken_per_death'), damageDealtPerDeath: numeric('damage_dealt_per_death'),
    deadTimePct: numeric('dead_time_pct'), laneGoldDiff: numeric('lane_gold_diff'),
    // 파이프라인
    isMmrEligible: boolean('is_mmr_eligible').notNull().default(true),
    isDeleted: boolean('is_deleted').notNull().default(false),    // 리플 삭제 soft delete
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

### 3.7 mmr_match_result

```ts
export const mmrMatchResult = pgTable(
  'mmr_match_result',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    calculationId: varchar('calculation_id', { length: 64 }).notNull(),
    baselineVersion: varchar('baseline_version', { length: 32 }).notNull(),
    guildId: varchar('guild_id', { length: 128 }).notNull(),
    season: varchar('season', { length: 32 }).notNull(),
    customMatchId: varchar('custom_match_id', { length: 255 }).notNull(),
    matchParticipantId: integer('match_participant_id').notNull(),
    puuid: varchar('puuid', { length: 128 }).notNull(),
    position: varchar('position', { length: 8 }).notNull(),
    gameResult: smallint('game_result').notNull(),
    preGameMmr: integer('pre_game_mmr').notNull(),
    mmrChange: integer('mmr_change').notNull(),
    postGameMmr: integer('post_game_mmr').notNull(),
    expectedScore: numeric('expected_score', { precision: 6, scale: 4 }).notNull(),
    actualScore: numeric('actual_score', { precision: 6, scale: 4 }).notNull(),
    relativeFactor: numeric('relative_factor', { precision: 6, scale: 4 }).notNull(),
    personalFactor: numeric('personal_factor', { precision: 6, scale: 4 }).notNull(),
    finalFactor: numeric('final_factor', { precision: 6, scale: 4 }).notNull(),
    isDeleted: boolean('is_deleted').notNull().default(false),    // 리플 삭제 soft delete
    calculatedDate: timestamp('calculated_date', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_mmr_match_result_calc_mpid').on(t.calculationId, t.matchParticipantId),
    index('idx_mmr_result_guild_season_puuid_calc').on(t.guildId, t.season, t.puuid, t.calculatedDate),
    index('idx_mmr_result_custom_match').on(t.customMatchId),
  ],
);
export type MmrMatchResult = typeof mmrMatchResult.$inferSelect;
export type InsertMmrMatchResult = typeof mmrMatchResult.$inferInsert;
```

### 3.8 mmr_history (partitioned)

> 실제 DB는 `create_date` 기준 monthly range partition([step01 §3.8](./step01_migration.md)). **Drizzle는 단일 논리 테이블로 다룬다** — 파티션·파티션별 인덱스는 raw SQL 마이그레이션이 관리하고, 여기선 INSERT/SELECT 매핑만 한다.

```ts
export const mmrHistory = pgTable(
  'mmr_history',
  {
    id: bigserial('id', { mode: 'number' }).notNull(),
    guildId: varchar('guild_id', { length: 128 }).notNull(),
    season: varchar('season', { length: 32 }).notNull(),
    puuid: varchar('puuid', { length: 128 }).notNull(),
    customMatchId: varchar('custom_match_id', { length: 255 }).notNull(),
    position: varchar('position', { length: 8 }).notNull(),
    mmrDelta: integer('mmr_delta').notNull(),
    beforeMmr: integer('before_mmr').notNull(),
    afterMmr: integer('after_mmr').notNull(),
    beforePosMmr: integer('before_pos_mmr').notNull(),
    afterPosMmr: integer('after_pos_mmr').notNull(),
    mmrMatchResultId: bigint('mmr_match_result_id', { mode: 'number' }).notNull(),
    isDeleted: boolean('is_deleted').notNull().default(false),    // 리플 삭제 soft delete
    createDate: timestamp('create_date', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_mmr_history', columns: [t.id, t.createDate] }),
    index('idx_mmr_history_guild_season_puuid_create').on(t.guildId, t.season, t.puuid, t.createDate),
  ],
);
export type MmrHistory = typeof mmrHistory.$inferSelect;
export type InsertMmrHistory = typeof mmrHistory.$inferInsert;
```

> `bigserial`의 시퀀스는 파티션 부모에 붙는다. INSERT 시 `id`는 자동 채번되고, 라우팅은 `create_date`로 파티션이 결정한다.

### 3.9 mmr_member_summary

```ts
export const mmrMemberSummary = pgTable(
  'mmr_member_summary',
  {
    guildId: varchar('guild_id', { length: 128 }).notNull(),
    season: varchar('season', { length: 32 }).notNull(),
    puuid: varchar('puuid', { length: 128 }).notNull(),
    totalMmr: integer('total_mmr').notNull(),   // 초기값은 앱이 config(현재 1300, 변경 여지)로 세팅 — DB default 아님
    totalGames: integer('total_games').notNull().default(0),
    totalWins: integer('total_wins').notNull().default(0),
    topMmr: integer('top_mmr').notNull(),   // 초기값은 앱이 config(현재 1300, 변경 여지)로 세팅 — DB default 아님
    topGames: integer('top_games').notNull().default(0),
    topWins: integer('top_wins').notNull().default(0),
    jugMmr: integer('jug_mmr').notNull(),   // 초기값은 앱이 config(현재 1300, 변경 여지)로 세팅 — DB default 아님
    jugGames: integer('jug_games').notNull().default(0),
    jugWins: integer('jug_wins').notNull().default(0),
    midMmr: integer('mid_mmr').notNull(),   // 초기값은 앱이 config(현재 1300, 변경 여지)로 세팅 — DB default 아님
    midGames: integer('mid_games').notNull().default(0),
    midWins: integer('mid_wins').notNull().default(0),
    adcMmr: integer('adc_mmr').notNull(),   // 초기값은 앱이 config(현재 1300, 변경 여지)로 세팅 — DB default 아님
    adcGames: integer('adc_games').notNull().default(0),
    adcWins: integer('adc_wins').notNull().default(0),
    supMmr: integer('sup_mmr').notNull(),   // 초기값은 앱이 config(현재 1300, 변경 여지)로 세팅 — DB default 아님
    supGames: integer('sup_games').notNull().default(0),
    supWins: integer('sup_wins').notNull().default(0),
    isDeleted: boolean('is_deleted').notNull().default(false),
    updateDate: timestamp('update_date', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    primaryKey({ name: 'pk_mmr_member_summary', columns: [t.guildId, t.season, t.puuid] }),
    index('idx_mmr_member_summary_leaderboard').on(t.guildId, t.season, t.totalMmr).where(sql`is_deleted = FALSE`),
  ],
);
export type MmrMemberSummary = typeof mmrMemberSummary.$inferSelect;
export type InsertMmrMemberSummary = typeof mmrMemberSummary.$inferInsert;
```

---

## 4. 주의점

| 항목 | 내용 |
|---|---|
| `numeric` 타입 | Drizzle `numeric`은 **string**으로 추론된다. 서비스에서 `expected_score` 등 다룰 때 `Number()` 변환 또는 string 유지 일관성 결정 (step09에서 확정). |
| `bigserial` mode | `bigserial('id', { mode: 'number' })`로 JS number 추론. 시퀀스가 2^53 넘을 일은 없음. insert 시 `id` 생략. |
| PK 방식 | step01 DDL(`SERIAL`/`BIGSERIAL`)과 동일하게 Drizzle도 `serial`/`bigserial` 사용. (레포 일부 테이블은 `generatedAlwaysAsIdentity()`를 쓰나, MMR은 마이그레이션과 일치시킴.) |
| 파티션 테이블 | `mmr_history`는 Drizzle로 **생성하지 않는다**. `drizzle-kit`을 쓰더라도 이 테이블은 raw SQL(step01) 관리 대상으로 제외. |
| partial index | `uniqueIndex(...).where(sql\`...\`)`는 Drizzle 메타로 표현만 한다. 실제 생성은 step01 SQL. 정의를 양쪽에 **일치**시켜 둔다. |
| `$onUpdate` | `update_date`는 Drizzle update 시 앱 레벨에서 채운다(DB 트리거 아님). raw SQL UPDATE 경로에서는 명시적으로 `update_date = NOW()`를 써야 한다(step09 주의). |
| 명명 | 컬럼 JS명은 camelCase, DB명은 snake_case로 명시. step01 DDL과 한 글자도 어긋나지 않게. |

---

## 5. 완료 기준 (DoD)

- [ ] 9개 `pgTable` + 각 `$inferSelect`/`$inferInsert` 타입 export가 `schema.ts`에 추가됨
- [ ] 컬럼명(snake_case)·타입·제약이 [step01](./step01_migration.md) DDL과 100% 일치
- [ ] `tsc` 타입 체크 통과 (기존 `guild`/`customMatch`/`matchParticipant` 참조 정상)
- [ ] FK는 `mmr_match_queue.custom_match_id → custom_match.id` 하나뿐 (`mmr_participant_metric`은 FK 없음)
- [ ] `mmr_participant_metric` UNIQUE = `(custom_match_id, puuid)`, raw/파생 컬럼 nullable
- [ ] partial unique(`baseline active`)·partial index(`leaderboard`) 정의가 SQL과 일치
- [ ] `mmr_history`는 복합 PK `(id, create_date)`, Drizzle 생성 대상에서 제외 명시

---

## 6. 의존성 / 다음 step

- **선행**: [step01](./step01_migration.md) (테이블이 실제로 존재해야 쿼리 가능)
- **후행**: [step03](./step03_metric_eligible.md)부터 이 타입들을 import해 서비스 구현
</content>
