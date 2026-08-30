/**
 * 리플 저장 시 경기의 팀 귀속을 자동 판정하는 순수 로직. DB 접근은 호출자(competitionTeam.service)가 한다.
 */

/** 한 진영 5명 중 이만큼이 같은 로스터에 있으면 그 팀 경기로 본다 (4+1 용병도 정상 배정). */
export const AUTO_ASSIGN_MAJORITY = 3;

export type SideDecision =
  | { kind: 'team'; teamId: number }
  | { kind: 'mercenary' }
  | { kind: 'undecided' };

export interface MatchTeamAssignment {
  blueTeamId: number | null;
  redTeamId: number | null;
}

/**
 * 한 진영 참가자들의 로스터 팀(로스터에 없으면 null)으로 그 진영의 귀속을 판정한다.
 * 로스터 소속이 1~2명뿐이면 확정하지 않는다 — 상대 팀원이 섞여 들어온 경기일 수 있다.
 */
export const decideSide = (teamIds: (number | null)[]): SideDecision => {
  const counts = new Map<number, number>();
  for (const teamId of teamIds) {
    if (teamId != null) counts.set(teamId, (counts.get(teamId) ?? 0) + 1);
  }
  if (counts.size === 0) return { kind: 'mercenary' };

  const majority = [...counts.entries()].filter(([, count]) => count >= AUTO_ASSIGN_MAJORITY);
  if (majority.length !== 1) return { kind: 'undecided' };
  return { kind: 'team', teamId: majority[0][0] };
};

/** 양 진영 판정 → 저장할 귀속. null이면 저장하지 않고 미배정으로 남긴다(운영진 수동 지정). */
export const decideMatchTeams = (
  blue: SideDecision,
  red: SideDecision,
): MatchTeamAssignment | null => {
  if (blue.kind === 'undecided' || red.kind === 'undecided') return null;
  if (blue.kind === 'mercenary' && red.kind === 'mercenary') return null;
  if (blue.kind === 'team' && red.kind === 'team' && blue.teamId === red.teamId) return null;

  return {
    blueTeamId: blue.kind === 'team' ? blue.teamId : null,
    redTeamId: red.kind === 'team' ? red.teamId : null,
  };
};
