import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { CompetitionApplyInput, CompetitionPosition } from '../types/competition.js';

/**
 * DB는 결과 큐로 대신한다 — 쿼리 빌더의 모든 체인 메서드는 자기 자신을 돌려주고,
 * await 하는 순간 큐에서 하나를 꺼낸다(Error를 넣으면 그 자리에서 던진다).
 * 따라서 각 테스트의 큐는 서비스가 실행하는 쿼리 순서 그대로다.
 */
let queue: unknown[] = [];
/** insert/update에 넘어간 값 — 저장 직전 정규화가 실제로 걸렸는지 보려고 모은다. */
let written: unknown[] = [];
/** .for(...)로 요청한 행 잠금 — 상태 확인과 상한 검사가 잠금 안에서 도는지 보려고 모은다. */
let locks: unknown[] = [];

const CHAIN_METHODS = [
  'from',
  'where',
  'limit',
  'returning',
  'orderBy',
  'innerJoin',
  'leftJoin',
  'groupBy',
  'onConflictDoUpdate',
  'onConflictDoNothing',
];

const makeBuilder = (): Record<string, unknown> => {
  const builder: Record<string, unknown> = {};
  for (const method of CHAIN_METHODS) {
    builder[method] = () => builder;
  }
  builder.values = (value: unknown) => {
    written.push(value);
    return builder;
  };
  builder.set = (value: unknown) => {
    written.push(value);
    return builder;
  };
  builder.for = (mode: unknown) => {
    locks.push(mode);
    return builder;
  };
  builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
    const value = queue.length > 0 ? queue.shift() : [];
    return value instanceof Error
      ? Promise.reject(value).then(resolve, reject)
      : Promise.resolve(value).then(resolve, reject);
  };
  return builder;
};

const executor: Record<string, unknown> = {
  select: () => makeBuilder(),
  selectDistinct: () => makeBuilder(),
  insert: () => makeBuilder(),
  update: () => makeBuilder(),
  delete: () => makeBuilder(),
  transaction: async (callback: (tx: unknown) => unknown) => callback(executor),
};

jest.unstable_mockModule('../database/connectionPool.js', () => ({ db: executor }));
jest.unstable_mockModule('../services/systemConfig.service.js', () => ({
  systemConfigService: {
    getConfigOrDefault: jest.fn(async (_key: unknown, defaultValue: unknown) => defaultValue),
  },
}));

const {
  CompetitionTeamService,
  MAX_ROSTER_SIZE,
  MAX_TEAMS_PER_COMPETITION,
  visibleApplicationStatus,
} = await import('../services/competitionTeam.service.js');

const service = new CompetitionTeamService();
const GUILD = 'guild-1';
const COMPETITION = 7;
const TEAM = 5;
const ACTOR = { memberId: 'member-1', source: 'web' } as const;

const applyInput = (extra: Partial<CompetitionApplyInput> = {}): CompetitionApplyInput => ({
  playerCode: 'PLR_000001',
  mainPosition: 'TOP',
  captainAvailable: false,
  practiceLevel: 'MODERATE',
  ...extra,
});

const rosterMember = (extra: { playerCode?: string; position?: CompetitionPosition } = {}) => ({
  playerCode: 'PLR_000001',
  position: 'TOP' as CompetitionPosition,
  ...extra,
});

const recruitingCompetition = [{ id: COMPETITION, status: 'RECRUITING', approvalRequired: true }];
const inProgressCompetition = [{ id: COMPETITION, status: 'IN_PROGRESS', approvalRequired: true }];
const closedCompetition = [{ id: COMPETITION, status: 'CLOSED', approvalRequired: true }];
const teamRow = [
  {
    id: TEAM,
    competitionId: COMPETITION,
    name: '1팀',
    captainPlayerCode: null,
    createDate: new Date(),
  },
];

const uniqueViolation = (constraint: string) =>
  Object.assign(new Error('duplicate key value'), { cause: { code: '23505', constraint } });

const expectStatus = (promise: Promise<unknown>, status: number, type: string) =>
  expect(promise).rejects.toMatchObject({ status, type });

beforeEach(() => {
  queue = [];
  written = [];
  locks = [];
});

describe('종료된 대회는 잠긴다 (409)', () => {
  test('팀 생성', async () => {
    queue = [closedCompetition];
    await expectStatus(service.createTeam(GUILD, COMPETITION, '1팀'), 409, 'competition-closed');
  });

  test('로스터 등록', async () => {
    queue = [closedCompetition];
    await expectStatus(
      service.addMember(GUILD, COMPETITION, TEAM, rosterMember()),
      409,
      'competition-closed',
    );
  });

  test('로스터 제거', async () => {
    queue = [closedCompetition];
    await expectStatus(
      service.removeMember(GUILD, COMPETITION, TEAM, 'PLR_000001'),
      409,
      'competition-closed',
    );
  });

  test('신청 결정', async () => {
    queue = [closedCompetition];
    await expectStatus(
      service.decideApplications(GUILD, COMPETITION, [1], 'APPROVED', ACTOR),
      409,
      'competition-closed',
    );
  });

  test('본인 신청 수정', async () => {
    queue = [closedCompetition];
    await expectStatus(
      service.updateMyApplication(GUILD, COMPETITION, 'member-1', { mainPosition: 'MID' }),
      409,
      'competition-closed',
    );
  });

  test('본인 신청 취소', async () => {
    queue = [closedCompetition];
    await expectStatus(
      service.deleteMyApplication(GUILD, COMPETITION, 'member-1'),
      409,
      'competition-closed',
    );
  });

  test('로스터 전체 저장', async () => {
    queue = [closedCompetition];
    await expectStatus(
      service.saveRoster(GUILD, COMPETITION, { teams: [] }),
      409,
      'competition-closed',
    );
  });

  test('경기 팀 귀속', async () => {
    queue = [closedCompetition];
    await expectStatus(
      service.assignMatchTeams(
        GUILD,
        COMPETITION,
        'match-1',
        { blue: TEAM, red: null },
        { memberId: 'member-1', source: 'web' },
      ),
      409,
      'competition-closed',
    );
  });
});

describe('신청은 모집중에만 받는다', () => {
  const apply = () => service.apply(GUILD, COMPETITION, applyInput(), 'member-1');

  test('진행중이면 거부한다 (409)', async () => {
    queue = [inProgressCompetition];
    await expectStatus(apply(), 409, 'competition-not-recruiting');
  });

  test('종료된 대회는 다른 쓰기 작업과 같은 competition-closed로 막는다', async () => {
    queue = [closedCompetition];
    await expectStatus(apply(), 409, 'competition-closed');
  });

  test('승인이 필요한 대회는 PENDING으로 들어간다', async () => {
    queue = [recruitingCompetition, [], [{ id: 1 }]];
    await apply();
    expect(written).toEqual([expect.objectContaining({ status: 'PENDING', decidedDate: null })]);
  });

  test('승인이 필요 없는 대회는 신청 즉시 APPROVED가 된다', async () => {
    queue = [[{ id: COMPETITION, status: 'RECRUITING', approvalRequired: false }], [], [{ id: 1 }]];
    await apply();
    expect(written).toEqual([expect.objectContaining({ status: 'APPROVED' })]);
    expect((written[0] as { decidedByMemberId?: string }).decidedByMemberId).toBeUndefined();
    expect((written[0] as { decidedDate: Date | null }).decidedDate).toBeInstanceOf(Date);
  });

  test('팀·로스터 작업은 진행중에도 열려 있다', async () => {
    queue = [inProgressCompetition, [{ teams: 0 }], [{ id: 1 }]];
    await expect(service.createTeam(GUILD, COMPETITION, '1팀')).resolves.toEqual({ id: 1 });
  });
});

describe('상한 (409)', () => {
  test(`대회당 팀은 ${MAX_TEAMS_PER_COMPETITION}개까지`, async () => {
    queue = [recruitingCompetition, [{ teams: MAX_TEAMS_PER_COMPETITION }]];
    await expectStatus(service.createTeam(GUILD, COMPETITION, '21팀'), 409, 'team-limit-exceeded');
  });

  test(`팀당 로스터는 ${MAX_ROSTER_SIZE}명까지`, async () => {
    queue = [recruitingCompetition, teamRow, [], [{ size: MAX_ROSTER_SIZE }]];
    await expectStatus(
      service.addMember(GUILD, COMPETITION, TEAM, rosterMember()),
      409,
      'roster-limit-exceeded',
    );
  });

  test('상한 미만이면 통과한다', async () => {
    const created = { id: 1, competitionId: COMPETITION, teamId: TEAM, playerCode: 'PLR_000001' };
    queue = [recruitingCompetition, teamRow, [], [{ size: MAX_ROSTER_SIZE - 1 }], [created]];
    await expect(service.addMember(GUILD, COMPETITION, TEAM, rosterMember())).resolves.toEqual(
      created,
    );
  });
});

describe('중복 (409)', () => {
  test('같은 대회에 두 번 신청', async () => {
    queue = [recruitingCompetition, [], uniqueViolation('uq_competition_application')];
    await expectStatus(
      service.apply(GUILD, COMPETITION, applyInput(), 'member-1'),
      409,
      'application-duplicate',
    );
  });

  test('같은 대회에 같은 팀 이름', async () => {
    queue = [recruitingCompetition, [{ teams: 0 }], uniqueViolation('uq_competition_team_name')];
    await expectStatus(service.createTeam(GUILD, COMPETITION, '1팀'), 409, 'team-name-exists');
  });

  test('한 선수가 대회 안 두 팀에 소속', async () => {
    queue = [
      recruitingCompetition,
      teamRow,
      [],
      [{ size: 0 }],
      uniqueViolation('uq_competition_team_member_player'),
    ];
    await expectStatus(
      service.addMember(GUILD, COMPETITION, TEAM, rosterMember()),
      409,
      'roster-duplicate',
    );
  });
});

describe('본계정 정규화', () => {
  test('부캐로 신청해도 본계정으로 저장된다', async () => {
    const saved = { id: 1, competitionId: COMPETITION, playerCode: 'PLR_000100' };
    queue = [
      recruitingCompetition,
      [{ account: 'PLR_000200', mainAccount: 'PLR_000100' }],
      [{ playerCode: 'PLR_000100' }],
      [saved],
    ];
    await expect(
      service.apply(GUILD, COMPETITION, applyInput({ playerCode: 'PLR_000200' }), 'member-1'),
    ).resolves.toEqual(saved);
    expect(written).toEqual([expect.objectContaining({ playerCode: 'PLR_000100' })]);
  });

  test('부캐로 로스터에 넣어도 본계정으로 저장된다', async () => {
    queue = [
      recruitingCompetition,
      teamRow,
      [{ account: 'PLR_000200', mainAccount: 'PLR_000100' }],
      [{ playerCode: 'PLR_000100' }],
      [{ size: 0 }],
      [{ id: 1 }],
    ];
    await service.addMember(GUILD, COMPETITION, TEAM, rosterMember({ playerCode: 'PLR_000200' }));
    expect(written).toEqual([expect.objectContaining({ playerCode: 'PLR_000100' })]);
  });

  test('본계정 링크가 가리키는 계정이 사라졌으면 신청 계정 문제와 구분한다', async () => {
    queue = [recruitingCompetition, [{ account: 'PLR_000200', mainAccount: 'PLR_000100' }], []];
    await expectStatus(
      service.apply(GUILD, COMPETITION, applyInput({ playerCode: 'PLR_000200' }), 'member-1'),
      400,
      'main-account-not-found',
    );
  });
});

describe('경기 팀 귀속 검증 (400)', () => {
  test('양쪽 다 용병전으로는 지정할 수 없다', async () => {
    await expectStatus(
      service.assignMatchTeams(
        GUILD,
        COMPETITION,
        'match-1',
        { blue: null, red: null },
        { memberId: 'member-1', source: 'web' },
      ),
      400,
      'match-team-required',
    );
  });

  test('양쪽에 같은 팀은 지정할 수 없다', async () => {
    await expectStatus(
      service.assignMatchTeams(
        GUILD,
        COMPETITION,
        'match-1',
        { blue: TEAM, red: TEAM },
        { memberId: 'member-1', source: 'web' },
      ),
      400,
      'match-team-duplicate',
    );
  });

  test('이 대회 팀이 아니면 거부한다', async () => {
    queue = [recruitingCompetition, [{ id: 'match-1' }], []];
    await expectStatus(
      service.assignMatchTeams(
        GUILD,
        COMPETITION,
        'match-1',
        { blue: TEAM, red: null },
        { memberId: 'member-1', source: 'web' },
      ),
      400,
      'team-not-in-competition',
    );
  });
});

describe('행 잠금', () => {
  test('팀 생성은 대회 행을 FOR UPDATE로 잡고 20팀을 센다', async () => {
    queue = [recruitingCompetition, [{ teams: 0 }], [{ id: 1 }]];
    await service.createTeam(GUILD, COMPETITION, '1팀');
    expect(locks).toEqual(['update']);
  });

  test('로스터 등록은 대회를 FOR SHARE, 팀을 FOR UPDATE로 잡는다', async () => {
    queue = [recruitingCompetition, teamRow, [], [{ size: 0 }], [{ id: 1 }]];
    await service.addMember(GUILD, COMPETITION, TEAM, rosterMember());
    expect(locks).toEqual(['share', 'update']);
  });
});

describe('자동 배정 결과', () => {
  const sideMembers = (gameTeam: string, prefix: string) =>
    [1, 2, 3].map((n) => ({ gameTeam, playerCode: `PLR_${prefix}${n}` }));
  const autoAssign = (participants: { gameTeam: string; playerCode: string }[]) =>
    service.tryAutoAssignMatchTeams(
      { guildId: GUILD, competitionId: COMPETITION, customMatchId: 'match-1' },
      participants,
      executor as never,
    );

  test('양 진영이 다수결로 잡히면 assigned', async () => {
    const participants = [...sideMembers('blue', 'b'), ...sideMembers('red', 'r')];
    queue = [
      [],
      participants.map((p) => ({
        playerCode: p.playerCode,
        teamId: p.gameTeam === 'blue' ? 1 : 2,
      })),
    ];

    await expect(autoAssign(participants)).resolves.toEqual({
      status: 'assigned',
      blueTeamId: 1,
      redTeamId: 2,
    });
  });

  test('한쪽만 로스터면 mercenary', async () => {
    const participants = [...sideMembers('blue', 'b'), ...sideMembers('red', 'r')];
    queue = [[], sideMembers('blue', 'b').map((p) => ({ playerCode: p.playerCode, teamId: 1 }))];

    await expect(autoAssign(participants)).resolves.toEqual({
      status: 'mercenary',
      blueTeamId: 1,
      redTeamId: null,
    });
  });

  test('로스터에 아무도 없으면 unassigned', async () => {
    queue = [[], []];
    await expect(autoAssign(sideMembers('blue', 'b'))).resolves.toEqual({ status: 'unassigned' });
  });

  test('savepoint 안에서 터져도 리플 저장을 실패시키지 않고 unassigned', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    queue = [new Error('roster lookup failed')];

    await expect(autoAssign([{ gameTeam: 'blue', playerCode: 'PLR_000001' }])).resolves.toEqual({
      status: 'unassigned',
    });

    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  test('대회 경기가 아니면 쿼리조차 하지 않는다', async () => {
    queue = [new Error('should not run')];
    await expect(
      service.tryAutoAssignMatchTeams(
        { guildId: GUILD, competitionId: null, customMatchId: 'match-1' },
        [{ gameTeam: 'blue', playerCode: 'PLR_000001' }],
        executor as never,
      ),
    ).resolves.toEqual({ status: 'unassigned' });
    expect(queue).toHaveLength(1);
  });
});

describe('경기 유형 일괄 변경', () => {
  const changeToMain = (ids: string[]) =>
    service.changeMatchGameType(GUILD, COMPETITION, ids, '3', ACTOR);

  test('종료된 대회는 잠긴다', async () => {
    queue = [closedCompetition];
    await expectStatus(changeToMain(['m1']), 409, 'competition-closed');
  });

  test('하나라도 이 대회 경기가 아니면 404이고 아무것도 쓰지 않는다', async () => {
    queue = [inProgressCompetition, [{ id: 'm1', gameType: '2' }]];
    await expect(changeToMain(['m1', 'm2'])).rejects.toMatchObject({
      status: 404,
      type: 'match-not-found',
      message: expect.stringContaining('m2'),
    });
    expect(written).toEqual([]);
  });

  test('이미 목표 유형이면 skipped로 빠지고 쓰지 않는다', async () => {
    queue = [inProgressCompetition, [{ id: 'm1', gameType: '3' }]];
    await expect(changeToMain(['m1'])).resolves.toEqual({ changed: [], skipped: ['m1'] });
    expect(written).toEqual([]);
  });

  test('바뀐 경기는 세 테이블을 갱신하고 경기마다 감사 로그를 남긴다', async () => {
    queue = [
      inProgressCompetition,
      [
        { id: 'm1', gameType: '2' },
        { id: 'm2', gameType: '3' },
      ],
    ];

    await expect(changeToMain(['m1', 'm2'])).resolves.toEqual({
      changed: ['m1'],
      skipped: ['m2'],
    });
    expect(written.slice(0, 3)).toEqual([
      { gameType: '3' },
      { gameType: '3', updateDate: expect.any(Date) },
      { gameType: '3' },
    ]);
    expect(written[3]).toEqual([
      {
        guildId: GUILD,
        eventType: 'matchGameTypeChange',
        actorMemberId: ACTOR.memberId,
        detail: {
          competitionId: COMPETITION,
          customMatchId: 'm1',
          from: '2',
          to: '3',
          source: 'web',
        },
      },
    ]);
  });

  test('대회는 FOR SHARE, 대상 경기는 FOR UPDATE로 잡는다', async () => {
    queue = [inProgressCompetition, [{ id: 'm1', gameType: '2' }]];
    await changeToMain(['m1']);
    expect(locks).toEqual(['share', 'update']);
  });
});

describe('전적 집계의 승자 해석', () => {
  const side = (gameTeam: string, won: boolean) => ({
    customMatchId: 'm1',
    gameTeam,
    won,
    kill: 10,
    death: 5,
    assist: 20,
  });
  const assignedMatch = {
    competitionId: COMPETITION,
    customMatchId: 'm1',
    gameType: '2',
    date: new Date('2026-08-01T00:00:00Z'),
    blueTeamId: 1,
    redTeamId: 2,
  };
  const headToHead = () => service.getHeadToHead(GUILD, COMPETITION, 1, 2);

  test('blue 진영이 이기면 blueTeamId가 승자', async () => {
    queue = [
      recruitingCompetition,
      teamRow,
      teamRow,
      [assignedMatch],
      [side('blue', true), side('red', false)],
    ];
    const result = await headToHead();
    expect(result.scrim).toEqual({ games: 1, win: 1, lose: 0 });
    expect(result.matches).toEqual([
      { customMatchId: 'm1', gameType: '2', date: assignedMatch.date, winnerTeamId: 1 },
    ]);
  });

  test('red 진영이 이기면 redTeamId가 승자', async () => {
    queue = [
      recruitingCompetition,
      teamRow,
      teamRow,
      [assignedMatch],
      [side('blue', false), side('red', true)],
    ];
    const result = await headToHead();
    expect(result.scrim).toEqual({ games: 1, win: 0, lose: 1 });
    expect(result.matches[0].winnerTeamId).toBe(2);
  });

  test('승자 행이 없으면 판수만 세고 승패는 비운다', async () => {
    queue = [recruitingCompetition, teamRow, teamRow, [assignedMatch], []];
    const result = await headToHead();
    expect(result.scrim).toEqual({ games: 1, win: 0, lose: 0 });
    expect(result.matches[0].winnerTeamId).toBeNull();
  });

  test('한쪽이라도 귀속이 없으면 집계에서 빠진다', async () => {
    queue = [recruitingCompetition, teamRow, teamRow, [{ ...assignedMatch, redTeamId: null }]];
    const result = await headToHead();
    expect(result.scrim).toEqual({ games: 0, win: 0, lose: 0 });
    expect(result.matches).toEqual([]);
  });

  test('같은 팀끼리는 조회할 수 없다', async () => {
    await expectStatus(service.getHeadToHead(GUILD, COMPETITION, 1, 1), 400, 'team-same');
  });
});

describe('신청 v2 검증', () => {
  test('부포지션에 주포지션이 들어가면 거부한다 (400)', async () => {
    queue = [recruitingCompetition];
    await expectStatus(
      service.apply(GUILD, COMPETITION, applyInput({ subPositions: ['TOP', 'MID'] }), 'member-1'),
      400,
      'sub-position-invalid',
    );
  });

  test('부포지션이 중복이면 거부한다 (400)', async () => {
    queue = [recruitingCompetition];
    await expectStatus(
      service.apply(GUILD, COMPETITION, applyInput({ subPositions: ['MID', 'MID'] }), 'member-1'),
      400,
      'sub-position-invalid',
    );
  });

  test('선호 챔피언이 중복이면 거부한다 (400)', async () => {
    queue = [recruitingCompetition];
    await expectStatus(
      service.apply(GUILD, COMPETITION, applyInput({ champions: ['266', '266'] }), 'member-1'),
      400,
      'champion-duplicate',
    );
  });

  test('등록되지 않은 챔피언은 거부한다 (400)', async () => {
    queue = [recruitingCompetition, [{ id: '266' }]];
    await expectStatus(
      service.apply(GUILD, COMPETITION, applyInput({ champions: ['266', '999'] }), 'member-1'),
      400,
      'champion-not-found',
    );
  });

  test('부포지션·챔피언이 그대로 저장된다', async () => {
    queue = [recruitingCompetition, [{ id: '266' }], [], [{ id: 1 }]];
    await service.apply(
      GUILD,
      COMPETITION,
      applyInput({ subPositions: ['MID'], champions: ['266'] }),
      'member-1',
    );
    expect(written).toEqual([
      expect.objectContaining({
        mainPosition: 'TOP',
        subPositions: ['MID'],
        champions: ['266'],
        practiceLevel: 'MODERATE',
        captainAvailable: false,
      }),
    ]);
  });
});

describe('본인 신청 조회', () => {
  const applicationRow = (champions: string[]) => ({
    competition_application: { id: 1, competitionId: COMPETITION, champions },
    riot_account: { riotName: '소환사', riotNameTag: 'KR1' },
  });

  test('신청이 없으면 404', async () => {
    queue = [recruitingCompetition, []];
    await expectStatus(
      service.getMyApplication(GUILD, COMPETITION, 'member-1'),
      404,
      'application-not-found',
    );
  });

  test('챔피언 id를 이름으로 채운다', async () => {
    queue = [
      recruitingCompetition,
      [applicationRow(['266'])],
      [{ id: '266', champName: '아트록스', champNameEng: 'Aatrox' }],
    ];
    const item = await service.getMyApplication(GUILD, COMPETITION, 'member-1');
    expect(item.riotName).toBe('소환사');
    expect(item.champions).toEqual([{ id: '266', champName: '아트록스', champNameEng: 'Aatrox' }]);
  });
});

describe('본인 신청 수정·취소', () => {
  const current = {
    id: 11,
    competitionId: COMPETITION,
    mainPosition: 'TOP',
    subPositions: ['MID'],
    status: 'APPROVED',
  };

  test('진행중 대회는 수정할 수 없다 (409)', async () => {
    queue = [inProgressCompetition];
    await expectStatus(
      service.updateMyApplication(GUILD, COMPETITION, 'member-1', { comment: '수정' }),
      409,
      'competition-not-recruiting',
    );
  });

  test('신청이 없으면 404', async () => {
    queue = [recruitingCompetition, []];
    await expectStatus(
      service.updateMyApplication(GUILD, COMPETITION, 'member-1', { comment: '수정' }),
      404,
      'application-not-found',
    );
  });

  test('주포지션만 바꿔도 남아 있던 부포지션과 겹치면 거부한다 (400)', async () => {
    queue = [recruitingCompetition, [current]];
    await expectStatus(
      service.updateMyApplication(GUILD, COMPETITION, 'member-1', { mainPosition: 'MID' }),
      400,
      'sub-position-invalid',
    );
  });

  test('수정해도 승인 상태는 건드리지 않는다', async () => {
    queue = [recruitingCompetition, [current], [{ ...current, comment: '수정' }]];
    await service.updateMyApplication(GUILD, COMPETITION, 'member-1', { comment: '수정' });
    expect(written).toEqual([{ comment: '수정' }]);
  });

  test('playerCode를 바꾸면 본계정으로 정규화하고, 그 계정이 이미 신청돼 있으면 409', async () => {
    queue = [
      recruitingCompetition,
      [current],
      [{ account: 'PLR_000200', mainAccount: 'PLR_000100' }],
      [{ playerCode: 'PLR_000100' }],
      uniqueViolation('uq_competition_application'),
    ];
    await expectStatus(
      service.updateMyApplication(GUILD, COMPETITION, 'member-1', { playerCode: 'PLR_000200' }),
      409,
      'application-duplicate',
    );
    expect(written).toEqual([{ playerCode: 'PLR_000100' }]);
  });

  test('취소는 조회·수정이 고르는 한 건을 찾아 그 행만 지운다', async () => {
    const newest = { id: 12, competitionId: COMPETITION, playerCode: 'PLR_000002' };
    queue = [recruitingCompetition, [newest], [newest]];
    await expect(service.deleteMyApplication(GUILD, COMPETITION, 'member-1')).resolves.toEqual(
      newest,
    );
    expect(queue).toHaveLength(0);
  });

  test('취소할 신청이 없으면 404', async () => {
    queue = [recruitingCompetition, []];
    await expectStatus(
      service.deleteMyApplication(GUILD, COMPETITION, 'member-1'),
      404,
      'application-not-found',
    );
  });
});

describe('신청 일괄 결정', () => {
  test('없는 id가 섞이면 404이고 감사 로그도 남지 않는다', async () => {
    queue = [recruitingCompetition, [{ id: 1, playerCode: 'PLR_000001' }]];
    await expectStatus(
      service.decideApplications(GUILD, COMPETITION, [1, 2], 'APPROVED', ACTOR),
      404,
      'application-not-found',
    );
    expect(written).toHaveLength(1);
  });

  test('PENDING으로 되돌리면 결정 기록을 지운다', async () => {
    queue = [recruitingCompetition, [{ id: 1, playerCode: 'PLR_000001' }], []];
    await service.decideApplications(GUILD, COMPETITION, [1], 'PENDING', ACTOR);
    expect(written[0]).toEqual({ status: 'PENDING', decidedByMemberId: null, decidedDate: null });
  });

  test('APPROVED는 결정자를 찍고 신청마다 감사 로그를 남긴다', async () => {
    queue = [
      recruitingCompetition,
      [
        { id: 1, playerCode: 'PLR_000001' },
        { id: 2, playerCode: 'PLR_000002' },
      ],
      [],
    ];
    await service.decideApplications(GUILD, COMPETITION, [1, 2], 'APPROVED', ACTOR);
    expect(written[0]).toMatchObject({ status: 'APPROVED', decidedByMemberId: 'member-1' });
    expect(written[1]).toEqual([
      {
        guildId: GUILD,
        eventType: 'applicationDecide',
        actorMemberId: 'member-1',
        detail: {
          competitionId: COMPETITION,
          applicationId: 1,
          playerCode: 'PLR_000001',
          status: 'APPROVED',
          source: 'web',
        },
      },
      {
        guildId: GUILD,
        eventType: 'applicationDecide',
        actorMemberId: 'member-1',
        detail: {
          competitionId: COMPETITION,
          applicationId: 2,
          playerCode: 'PLR_000002',
          status: 'APPROVED',
          source: 'web',
        },
      },
    ]);
  });
});

describe('로스터 전체 저장', () => {
  const team = (extra: Record<string, unknown> = {}) => ({
    name: '1팀',
    members: [rosterMember()],
    ...extra,
  });

  test('한 팀에 같은 포지션이 둘이면 거부한다 (409)', async () => {
    await expectStatus(
      service.saveRoster(GUILD, COMPETITION, {
        teams: [team({ members: [rosterMember(), rosterMember({ playerCode: 'PLR_000002' })] })],
      }),
      409,
      'roster-position-taken',
    );
  });

  test('같은 팀이 두 번 오면 거부한다 (400)', async () => {
    await expectStatus(
      service.saveRoster(GUILD, COMPETITION, {
        teams: [team({ id: TEAM }), team({ id: TEAM, name: '2팀' })],
      }),
      400,
      'team-duplicate',
    );
  });

  test(`저장도 대회당 ${MAX_TEAMS_PER_COMPETITION}팀까지 (409)`, async () => {
    const teams = Array.from({ length: MAX_TEAMS_PER_COMPETITION + 1 }, (_, index) => ({
      name: `${index + 1}팀`,
      members: [],
    }));
    await expectStatus(
      service.saveRoster(GUILD, COMPETITION, { teams }),
      409,
      'team-limit-exceeded',
    );
  });

  test('같은 선수가 두 팀에 있으면 거부한다 (409)', async () => {
    queue = [recruitingCompetition, []];
    await expectStatus(
      service.saveRoster(GUILD, COMPETITION, { teams: [team(), team({ name: '2팀' })] }),
      409,
      'roster-duplicate',
    );
  });

  test('팀장이 그 팀 로스터에 없으면 거부한다 (400)', async () => {
    queue = [recruitingCompetition, []];
    await expectStatus(
      service.saveRoster(GUILD, COMPETITION, {
        teams: [team({ captainPlayerCode: 'PLR_000009' })],
      }),
      400,
      'captain-not-in-roster',
    );
  });

  test('이 대회 팀이 아닌 id는 404', async () => {
    queue = [recruitingCompetition, [], [{ id: TEAM }]];
    await expectStatus(
      service.saveRoster(GUILD, COMPETITION, { teams: [team({ id: 99 })] }),
      404,
      'team-not-found',
    );
  });

  test('지워질 팀에 귀속된 경기가 있으면 전체가 실패한다 (409)', async () => {
    queue = [recruitingCompetition, [{ id: TEAM }], [{ matches: 1 }]];
    await expectStatus(
      service.saveRoster(GUILD, COMPETITION, { teams: [] }),
      409,
      'team-has-matches',
    );
  });

  test('payload에 없는 팀은 지우고 새 팀은 만든다', async () => {
    queue = [
      recruitingCompetition,
      [], // 본계정 링크
      [{ id: TEAM }], // 기존 팀
      [{ matches: 0 }], // 삭제 대상 팀의 귀속 경기
      [], // 귀속 경기 행
      [], // 팀 삭제
      [], // 기존 로스터
      [{ id: 30, name: '2팀' }], // 새 팀
      [], // 로스터 삽입
      [{ id: 30, name: '2팀' }], // 응답용 팀
      [
        {
          teamId: 30,
          playerCode: 'PLR_000001',
          position: 'TOP',
          riotName: '소환사',
          riotNameTag: 'KR1',
        },
      ],
    ];
    const saved = await service.saveRoster(GUILD, COMPETITION, { teams: [team({ name: '2팀' })] });
    expect(saved).toEqual([
      {
        id: 30,
        name: '2팀',
        roster: [
          { playerCode: 'PLR_000001', position: 'TOP', riotName: '소환사', riotNameTag: 'KR1' },
        ],
      },
    ]);
    expect(written).toContainEqual([
      { competitionId: COMPETITION, teamId: 30, playerCode: 'PLR_000001', position: 'TOP' },
    ]);
  });

  test('그대로인 자리는 두고 바뀐 자리만 다시 넣는다', async () => {
    queue = [
      recruitingCompetition,
      [], // 본계정 링크
      [{ id: TEAM, name: '1팀', captainPlayerCode: null }], // 기존 팀
      [
        { id: 1, teamId: TEAM, playerCode: 'PLR_000001', position: 'TOP' },
        { id: 2, teamId: TEAM, playerCode: 'PLR_000002', position: 'JUG' },
      ],
      [], // 자리가 바뀐 행 삭제
      [], // 로스터 삽입
      [{ id: TEAM, name: '1팀' }],
      [],
    ];
    await service.saveRoster(GUILD, COMPETITION, {
      teams: [
        team({
          id: TEAM,
          members: [rosterMember(), rosterMember({ playerCode: 'PLR_000002', position: 'MID' })],
        }),
      ],
    });
    // 이름·팀장이 그대로면 팀 UPDATE 자체가 나가지 않는다.
    expect(written).toEqual([
      [{ competitionId: COMPETITION, teamId: TEAM, playerCode: 'PLR_000002', position: 'MID' }],
    ]);
  });

  test('두 팀이 이름을 맞바꾸면 자리표를 거쳐 이름 유니크를 피한다', async () => {
    queue = [
      recruitingCompetition,
      [], // 본계정 링크
      [
        { id: 1, name: 'A팀', captainPlayerCode: null },
        { id: 2, name: 'B팀', captainPlayerCode: null },
      ],
      [
        { id: 10, teamId: 1, playerCode: 'PLR_000001', position: 'TOP' },
        { id: 11, teamId: 2, playerCode: 'PLR_000002', position: 'TOP' },
      ],
      [], // 자리표 UPDATE
      [], // 자리표 UPDATE
      [], // 최종 이름 UPDATE
      [], // 최종 이름 UPDATE
      [
        { id: 1, name: 'B팀' },
        { id: 2, name: 'A팀' },
      ],
      [],
    ];
    await service.saveRoster(GUILD, COMPETITION, {
      teams: [
        { id: 1, name: 'B팀', members: [rosterMember()] },
        { id: 2, name: 'A팀', members: [rosterMember({ playerCode: 'PLR_000002' })] },
      ],
    });
    expect(written).toEqual([
      { name: '\u00011' },
      { name: '\u00012' },
      { name: 'B팀', captainPlayerCode: null },
      { name: 'A팀', captainPlayerCode: null },
    ]);
  });
});

describe('신청 목록 가시성', () => {
  test('운영진이 아니면 필터를 생략해도 승인된 것만 본다', () => {
    expect(visibleApplicationStatus(undefined, false)).toBe('APPROVED');
  });

  test('운영진이 아니면 PENDING 지정은 403', () => {
    expect(() => visibleApplicationStatus('PENDING', false)).toThrow(
      expect.objectContaining({
        status: 403,
        type: 'application-status-forbidden',
      }) as unknown as Error,
    );
  });

  test('운영진이 아니면 REJECTED 지정도 403', () => {
    expect(() => visibleApplicationStatus('REJECTED', false)).toThrow(
      expect.objectContaining({
        status: 403,
        type: 'application-status-forbidden',
      }) as unknown as Error,
    );
  });

  test('운영진은 지정한 대로, 생략하면 전체를 본다', () => {
    expect(visibleApplicationStatus('PENDING', true)).toBe('PENDING');
    expect(visibleApplicationStatus(undefined, true)).toBeUndefined();
  });
});

describe('팀 목록', () => {
  test('로스터는 TOP·JUG·MID·ADC·SUP 순으로 나온다', async () => {
    queue = [
      recruitingCompetition,
      [{ id: TEAM, name: '1팀' }],
      [
        { teamId: TEAM, playerCode: 'PLR_3', position: 'SUP', riotName: 'c', riotNameTag: 'KR1' },
        { teamId: TEAM, playerCode: 'PLR_1', position: 'MID', riotName: 'b', riotNameTag: 'KR1' },
        { teamId: TEAM, playerCode: 'PLR_2', position: 'TOP', riotName: 'a', riotNameTag: 'KR1' },
      ],
    ];
    const [saved] = await service.listTeams(GUILD, COMPETITION);
    expect(saved.roster.map((member) => member.position)).toEqual(['TOP', 'MID', 'SUP']);
  });

  test('팀마다 상대를 가리지 않은 전체 전적이 붙는다', async () => {
    queue = [
      recruitingCompetition,
      [
        { id: TEAM, name: '1팀' },
        { id: 6, name: '2팀' },
      ],
      [],
      [
        {
          competitionId: COMPETITION,
          customMatchId: 'm1',
          gameType: '2',
          date: new Date(),
          blueTeamId: TEAM,
          redTeamId: 6,
        },
        {
          competitionId: COMPETITION,
          customMatchId: 'm2',
          gameType: '3',
          date: new Date(),
          blueTeamId: 6,
          redTeamId: TEAM,
        },
      ],
      [
        { customMatchId: 'm1', gameTeam: 'blue', won: true, kill: 1, death: 1, assist: 1 },
        { customMatchId: 'm1', gameTeam: 'red', won: false, kill: 1, death: 1, assist: 1 },
        { customMatchId: 'm2', gameTeam: 'blue', won: true, kill: 1, death: 1, assist: 1 },
        { customMatchId: 'm2', gameTeam: 'red', won: false, kill: 1, death: 1, assist: 1 },
      ],
    ];
    const [first, second] = await service.listTeams(GUILD, COMPETITION);

    expect(first.records).toEqual({
      scrim: { games: 1, win: 1, lose: 0 },
      main: { games: 1, win: 0, lose: 1 },
    });
    expect(second.records).toEqual({
      scrim: { games: 1, win: 0, lose: 1 },
      main: { games: 1, win: 1, lose: 0 },
    });
  });

  test('귀속된 경기가 없는 팀은 0판으로 남는다', async () => {
    queue = [recruitingCompetition, [{ id: TEAM, name: '1팀' }], [], []];
    const [team] = await service.listTeams(GUILD, COMPETITION);

    expect(team.records).toEqual({
      scrim: { games: 0, win: 0, lose: 0 },
      main: { games: 0, win: 0, lose: 0 },
    });
  });
});

describe('대회 순위표', () => {
  test('팀 목록과 귀속 경기를 합쳐 유형별 순위를 낸다', async () => {
    queue = [
      recruitingCompetition,
      [
        { competitionId: COMPETITION, id: TEAM, name: '1팀' },
        { competitionId: COMPETITION, id: 6, name: '2팀' },
      ],
      [
        {
          competitionId: COMPETITION,
          customMatchId: 'm1',
          gameType: '2',
          date: new Date(),
          blueTeamId: TEAM,
          redTeamId: 6,
        },
      ],
      [
        { customMatchId: 'm1', gameTeam: 'blue', won: true, kill: 20, death: 5, assist: 10 },
        { customMatchId: 'm1', gameTeam: 'red', won: false, kill: 5, death: 20, assist: 5 },
      ],
    ];
    const { scrim, main } = await service.getStandings(GUILD, COMPETITION);

    expect(scrim.map((team) => [team.name, team.rank, team.winRate, team.avgKda])).toEqual([
      ['1팀', 1, 100, 6],
      ['2팀', 2, 0, 0.5],
    ]);
    expect(main.every((team) => team.games === 0)).toBe(true);
  });
});

describe('대회 경기 목록', () => {
  const matchRow = (extra: Record<string, unknown> = {}) => ({
    customMatchId: 'm1',
    gameType: '2',
    date: new Date('2026-08-01T00:00:00Z'),
    blueTeamId: TEAM,
    redTeamId: 6,
    blueTeamName: '1팀',
    redTeamName: '2팀',
    ...extra,
  });
  const participant = (gameTeam: string, gameResult: string, timePlayed: number) => ({
    customMatchId: 'm1',
    gameTeam,
    gameResult,
    timePlayed,
    playerCode: `PLR_${gameTeam}`,
    riotName: gameTeam,
    riotNameTag: 'KR1',
  });

  test('팀 이름·승자 팀·경기 길이가 붙는다', async () => {
    queue = [
      recruitingCompetition,
      [matchRow()],
      [participant('blue', '패', 1800), participant('red', '승', 1802)],
    ];
    const [match] = await service.listMatches(GUILD, COMPETITION, false);

    expect(match).toMatchObject({
      blueTeamName: '1팀',
      redTeamName: '2팀',
      winnerTeamId: 6,
      gameLength: 1802,
    });
    expect(match.blue.map((player) => player.playerCode)).toEqual(['PLR_blue']);
  });

  test('용병전 진영은 팀 이름이 없고, 그 쪽이 이기면 승자도 없다', async () => {
    queue = [
      recruitingCompetition,
      [matchRow({ redTeamId: null, redTeamName: null })],
      [participant('blue', '패', 1500), participant('red', '승', 1500)],
    ];
    const [match] = await service.listMatches(GUILD, COMPETITION, false);

    expect(match).toMatchObject({ redTeamName: null, winnerTeamId: null, gameLength: 1500 });
  });

  test('참가자가 없으면 경기 길이는 비운다', async () => {
    queue = [recruitingCompetition, [matchRow()], []];
    const [match] = await service.listMatches(GUILD, COMPETITION, false);

    expect(match).toMatchObject({ gameLength: null, winnerTeamId: null });
  });
});
