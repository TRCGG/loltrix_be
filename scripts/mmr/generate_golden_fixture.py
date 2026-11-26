"""gmok_mmr(Python) 산식으로 TS 이식 대조용 golden fixture를 만든다.

산식·반올림·리포트 규칙이 gmok_mmr에서 바뀌면 이 스크립트를 다시 돌려 fixture를 갱신하고
src/test/mmrGolden.test.ts가 통과하는지 본다. DB에는 접근하지 않는다.

    python -I scripts/mmr/generate_golden_fixture.py <gmok_mmr 경로> src/test/fixtures/mmrGolden.json.gz
"""

from __future__ import annotations

import gzip
import json
import math
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

GMOK_MMR = Path(sys.argv[1]).resolve()
OUT = Path(sys.argv[2])
sys.path.insert(0, str(GMOK_MMR / "src"))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from mmr.gold.baseline import game_impact_baseline_from_payload  # noqa: E402
from mmr.gold.mmr import DEFAULT_MMR_SETTINGS, MMRBaselineStats, make_summary_df_wide, update_mmr_matches  # noqa: E402
from mmr.gold.report import build_position_report_records, build_user_position_report  # noqa: E402
from mmr.serving.service import build_feature_dataframe, calculate_baseline_payload  # noqa: E402

POSITIONS = ["TOP", "JUG", "MID", "ADC", "SUP"]
GUILD = "guild-golden"
SEASON = "2026"
RESULT_COLUMNS = [
    "guild_id", "season", "replay_code", "player_code", "champion_id", "team", "position",
    "played_at", "game_result", "kills", "deaths", "assists", "gold", "cc_time", "game_duration",
    "damage_to_champions", "damage_taken", "vision_score", "vision_bought", "penta_kills",
    "gold_per_min", "dpm", "damage_taken_per_min", "cc_time_per_min", "kda",
    "damage_taken_per_death", "damage_dealt_per_death", "raw_game_impact", "game_impact",
    "game_impact_winloss_norm", "game_n_person_contribution", "game_impact_vs_opponent",
    "pre_game_pos_mmr", "expected_score", "actual_score", "relative_factor", "personal_factor",
    "final_factor", "mmr_change", "pos_cumulative_mmr", "total_mmr",
]
SOURCE_COLUMNS = [
    "replay_code", "guild_id", "season", "player_code", "champion_id", "team", "position",
    "game_result", "played_at", "kills", "deaths", "assists", "penta_kills", "gold", "cc_time",
    "game_duration", "damage_to_champions", "damage_taken", "vision_score", "vision_bought", "exp",
    "damage_to_turrets", "minions_killed", "neutral_minions_killed", "wards_placed", "wards_killed",
    "heal_on_teammates", "shield_on_teammates",
]

rng = np.random.default_rng(349)


def player_row(replay_code, played_at, player_code, position, team, win, duration):
    boost = 1.15 if win else 0.9
    cs = {"TOP": 190, "JUG": 40, "MID": 200, "ADC": 220, "SUP": 30}[position]
    neutral = {"TOP": 10, "JUG": 150, "MID": 12, "ADC": 15, "SUP": 2}[position]
    return {
        "replay_code": replay_code,
        "guild_id": GUILD,
        "season": SEASON,
        "player_code": player_code,
        "champion_id": f"CHN_{int(rng.integers(1, 160))}",
        "team": team,
        "position": position,
        "game_result": 1 if win else 0,
        "played_at": played_at,
        "kills": int(rng.integers(0, 14) * boost),
        "deaths": int(rng.integers(0, 11) / boost),
        "assists": int(rng.integers(0, 19) * boost),
        "penta_kills": int(rng.random() < 0.01),
        "gold": int(rng.integers(6000, 17000) * boost),
        "cc_time": int(rng.integers(0, 60)),
        "game_duration": duration,
        "damage_to_champions": int(rng.integers(4000, 38000) * boost),
        "damage_taken": int(rng.integers(8000, 40000)),
        "vision_score": int(rng.integers(5, 80)),
        "vision_bought": int(rng.integers(0, 8)),
        "exp": int(rng.integers(8000, 18000) * boost),
        "damage_to_turrets": int(rng.integers(0, 9000) * boost),
        "minions_killed": int(cs * rng.uniform(0.6, 1.3)),
        "neutral_minions_killed": int(neutral * rng.uniform(0.5, 1.4)),
        "wards_placed": int(rng.integers(3, 40)),
        "wards_killed": int(rng.integers(0, 15)),
        "heal_on_teammates": int(rng.integers(0, 8000)) if position == "SUP" else int(rng.integers(0, 600)),
        "shield_on_teammates": int(rng.integers(0, 5000)) if position == "SUP" else int(rng.integers(0, 300)),
    }


def make_matches(count, pools, start, prefix, flex=()):
    rows = []
    for i in range(count):
        played_at = start + timedelta(hours=i)
        replay_code = f"{prefix}-{i:04d}"
        duration = int(rng.integers(1150, 2500))
        blue_wins = bool(rng.random() < 0.5)
        used = set()
        for position in POSITIONS:
            pool = [p for p in pools[position] if p not in used]
            pick = list(rng.choice(pool, size=2, replace=False))
            if flex and rng.random() < 0.12:
                spare = [p for p in flex if p not in used and p not in pick]
                if spare:
                    pick[int(rng.integers(0, 2))] = spare[int(rng.integers(0, len(spare)))]
            used.update(pick)
            for team, player in zip(("blue", "red"), pick):
                win = blue_wins if team == "blue" else not blue_wins
                rows.append(player_row(replay_code, played_at, str(player), position, team, win, duration))
    return rows


def iso(value):
    return value.isoformat().replace("+00:00", "Z")


def jsonable(value):
    if isinstance(value, (pd.Timestamp, datetime)):
        return iso(pd.Timestamp(value).to_pydatetime())
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating, float)):
        value = float(value)
        return None if math.isnan(value) else value
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    return value


def round_nested(value):
    # position_report JSON 안의 실수도 결과 컬럼처럼 pandas(numpy) 방식으로 둘째 자리 반올림한다.
    if isinstance(value, dict):
        return {k: round_nested(v) for k, v in value.items()}
    if isinstance(value, float):
        return float(np.round(value, 2))
    return value


# 1) 현실적인 값의 baseline (데이터팀 calculate_baseline_payload 그대로)
history_pools = {pos: [f"HIST_{pos}_{n}" for n in range(14)] for pos in POSITIONS}
history = make_matches(260, history_pools, datetime(2026, 1, 1, tzinfo=timezone.utc), "HIST")
baseline_payload = calculate_baseline_payload(
    {"matches": history, "season": SEASON, "baseline_version": "golden"}
)
baseline_payload["metadata"]["scope"] = "all_guilds"

# 2) 대조용 경기: 포지션 고정 선수 + 여러 포지션을 뛰는 선수.
# 스타일 분류가 실제로 돌도록 포지션마다 20판 넘는 선수가 5명 이상 되게 한다.
pools = {pos: [f"PLR_{pos}_{n}" for n in range(5)] for pos in POSITIONS}
flex = [f"PLR_FLEX_{n}" for n in range(3)]
matches = make_matches(66, pools, datetime(2026, 3, 1, 12, tzinfo=timezone.utc), "RPY", flex)

# 같은 시각의 두 경기: replay_code 코드포인트 순(대문자 < 소문자)이 계산 순서를 정한다
tie_time = matches[200]["played_at"]
for row in matches:
    if row["replay_code"] == "RPY-0020":
        row["replay_code"] = "RPY-0020a"
    if row["replay_code"] == "RPY-0021":
        row["replay_code"] = "RPY-0020B"
        row["played_at"] = tie_time

# 결측·경계 값
matches[3]["exp"] = None
matches[4]["wards_placed"] = None
matches[5]["heal_on_teammates"] = None
matches[6]["deaths"] = 0
matches[7]["kills"] = None
matches[8]["gold"] = None

# 5v5 구조가 깨진 경기(같은 포지션 두 명이 모두 승리) — 계산에서 빠져야 한다
for row in matches:
    if row["replay_code"] == "RPY-0030" and row["position"] == "MID":
        row["game_result"] = 1

order = rng.permutation(len(matches))
shuffled = [matches[i] for i in order]

feature_df = build_feature_dataframe(
    pd.DataFrame(shuffled), baseline=game_impact_baseline_from_payload(baseline_payload["game_impact_baseline"])
)
mmr_baseline = MMRBaselineStats(
    f1_mean=baseline_payload["mmr_baseline"]["f1_mean"],
    f2_mean=baseline_payload["mmr_baseline"]["f2_mean"],
    f1_position_mean=baseline_payload["mmr_baseline"]["f1_position_mean"],
    f2_position_mean=baseline_payload["mmr_baseline"]["f2_position_mean"],
)
results = update_mmr_matches(feature_df, baseline=mmr_baseline, settings=DEFAULT_MMR_SETTINGS)
results["season"] = SEASON

summary = make_summary_df_wide(results)
report = build_position_report_records(build_user_position_report(results))

float_cols = results[RESULT_COLUMNS].select_dtypes(include="floating").columns
stored = results[RESULT_COLUMNS].copy()
stored[float_cols] = stored[float_cols].round(2)

gmok_mmr_commit = subprocess.run(
    ["git", "-C", str(GMOK_MMR), "rev-parse", "--short", "HEAD"],
    capture_output=True, text=True, check=False,
).stdout.strip()

fixture = {
    "gmok_mmr_commit": gmok_mmr_commit,
    "baseline": {
        "id": 1,
        "season": SEASON,
        "baseline_version": "golden",
        "mmr_baseline": baseline_payload["mmr_baseline"],
        "game_impact_baseline": baseline_payload["game_impact_baseline"],
        "metadata": baseline_payload["metadata"],
    },
    "source_rows": [{k: jsonable(row[k]) for k in SOURCE_COLUMNS} for row in shuffled],
    "expected_results": [
        {k: jsonable(v) for k, v in row.items()} for row in stored.to_dict(orient="records")
    ],
    # 반올림 전 실수. 반올림이 가리는 산식 오차를 잡는 용도라 실수 컬럼만 담는다.
    "expected_unrounded": [
        {
            k: jsonable(row[k])
            for k in ["replay_code", "player_code", *float_cols, "cs_per_min", "exp_per_min", "lane_gold_diff"]
        }
        for row in results.to_dict(orient="records")
    ],
    "expected_summary": [
        {k: jsonable(v) for k, v in row.items()} for row in summary.to_dict(orient="records")
    ],
    "expected_reports": {
        row["player_code"]: round_nested(
            {pos: {k: jsonable(v) for k, v in vals.items()} for pos, vals in row["position_report"].items()}
        )
        for row in report.to_dict(orient="records")
    },
}

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_bytes(gzip.compress(json.dumps(fixture, ensure_ascii=False).encode("utf-8"), compresslevel=9))
print(
    f"gmok_mmr={gmok_mmr_commit} "
    f"matches={len(set(r['replay_code'] for r in matches))} results={len(results)} "
    f"summary={len(summary)} reports={len(report)} -> {OUT}"
)
