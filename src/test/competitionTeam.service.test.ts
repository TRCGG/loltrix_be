import { jest, describe, test, expect, beforeEach } from '@jest/globals';

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

const { CompetitionTeamService, MAX_ROSTER_SIZE, MAX_TEAMS_PER_COMPETITION } = await import(
  '../services/competitionTeam.service.js'
);

const service = new CompetitionTeamService();
const GUILD = 'guild-1';
const COMPETITION = 7;
const TEAM = 5;

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
      service.addMember(GUILD, COMPETITION, TEAM, 'PLR_000001'),
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

  test('신청 승인·거절', async () => {
    queue = [closedCompetition];
    await expectStatus(
      service.decideApplication(GUILD, COMPETITION, 1, 'APPROVED', {
        memberId: 'member-1',
        source: 'web',
      }),
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
  const apply = () =>
    service.apply(GUILD, COMPETITION, { playerCode: 'PLR_000001', title: '탑' }, 'member-1');

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
    queue = [
      [{ id: COMPETITION, status: 'RECRUITING', approvalRequired: false }],
      [],
      [{ id: 1 }],
    ];
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
      service.addMember(GUILD, COMPETITION, TEAM, 'PLR_000001'),
      409,
      'roster-limit-exceeded',
    );
  });

  test('상한 미만이면 통과한다', async () => {
    const created = { id: 1, competitionId: COMPETITION, teamId: TEAM, playerCode: 'PLR_000001' };
    queue = [recruitingCompetition, teamRow, [], [{ size: MAX_ROSTER_SIZE - 1 }], [created]];
    await expect(service.addMember(GUILD, COMPETITION, TEAM, 'PLR_000001')).resolves.toEqual(
      created,
    );
  });
});

describe('중복 (409)', () => {
  test('같은 대회에 두 번 신청', async () => {
    queue = [recruitingCompetition, [], uniqueViolation('uq_competition_application')];
    await expectStatus(
      service.apply(GUILD, COMPETITION, { playerCode: 'PLR_000001', title: '탑' }, 'member-1'),
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
      service.addMember(GUILD, COMPETITION, TEAM, 'PLR_000001'),
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
      service.apply(GUILD, COMPETITION, { playerCode: 'PLR_000200', title: '탑' }, 'member-1'),
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
    await service.addMember(GUILD, COMPETITION, TEAM, 'PLR_000200');
    expect(written).toEqual([expect.objectContaining({ playerCode: 'PLR_000100' })]);
  });

  test('본계정 링크가 가리키는 계정이 사라졌으면 신청 계정 문제와 구분한다', async () => {
    queue = [recruitingCompetition, [{ account: 'PLR_000200', mainAccount: 'PLR_000100' }], []];
    await expectStatus(
      service.apply(GUILD, COMPETITION, { playerCode: 'PLR_000200', title: '탑' }, 'member-1'),
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
    await service.addMember(GUILD, COMPETITION, TEAM, 'PLR_000001');
    expect(locks).toEqual(['share', 'update']);
  });
});

describe('자동 배정은 리플 저장을 실패시키지 않는다', () => {
  test('savepoint 안에서 터져도 정상 반환한다', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    queue = [new Error('roster lookup failed')];

    await expect(
      service.tryAutoAssignMatchTeams(
        { guildId: GUILD, competitionId: COMPETITION, customMatchId: 'match-1' },
        [{ gameTeam: 'blue', playerCode: 'PLR_000001' }],
        executor as never,
      ),
    ).resolves.toBeUndefined();

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
    ).resolves.toBeUndefined();
    expect(queue).toHaveLength(1);
  });
});

describe('전적 집계의 승자 해석', () => {
  const assignedMatch = {
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
      [{ customMatchId: 'm1', gameTeam: 'blue' }],
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
      [{ customMatchId: 'm1', gameTeam: 'red' }],
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
