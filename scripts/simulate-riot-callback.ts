/**
 * Riot 토너먼트 콜백 시뮬레이터 (TRC-225 단계4 검증용).
 *
 * stub 환경에서는 Riot이 실제 콜백을 보내지 않으므로, 이 스크립트로 로컬 서버에
 * 가짜 콜백을 POST 해 발급→콜백 엔드포인트 배선을 E2E로 검증한다.
 *
 * ⚠️ 실제 적재까지 검증하려면 shortCode가 DB에 PENDING으로 존재하고, region_gameId로
 *    match-v5 조회 시 info.tournamentCode가 그 shortCode와 일치해야 한다(재검증 불변식).
 *    stub 코드에는 대응하는 실제 match-v5가 없으므로 여기까지는 "match_code_mismatch/502"로
 *    막히는 게 정상이며, 이는 엔드포인트 배선·시크릿·PENDING 조회 경로 검증에 쓴다.
 *
 * 사용법 (Git Bash / tsx):
 *   RIOT_CALLBACK_SECRET=... npx tsx scripts/simulate-riot-callback.ts \
 *     --code <shortCode> --gameId <n> --region KR
 *
 * env:
 *   RIOT_CALLBACK_SECRET  (필수) 콜백 경로 시크릿
 *   CALLBACK_BASE_URL     (선택) 기본 http://localhost:3000
 */

interface Args {
  code: string;
  gameId: number;
  region: string;
}

function parseArgs(argv: string[]): Args {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      map.set(a.slice(2), argv[i + 1] ?? '');
      i += 1;
    }
  }
  return {
    code: map.get('code') ?? process.env.SIM_CODE ?? 'TEST-CODE-0001',
    gameId: Number(map.get('gameId') ?? process.env.SIM_GAME_ID ?? '1234567890'),
    region: map.get('region') ?? process.env.SIM_REGION ?? 'KR',
  };
}

async function main(): Promise<void> {
  const secret = process.env.RIOT_CALLBACK_SECRET;
  if (!secret) {
    console.error('RIOT_CALLBACK_SECRET 환경변수가 필요합니다.');
    process.exit(1);
  }

  const baseUrl = process.env.CALLBACK_BASE_URL || 'http://localhost:3000';
  const { code, gameId, region } = parseArgs(process.argv.slice(2));

  const url = `${baseUrl}/api/callback/riot/${encodeURIComponent(secret)}`;

  // Riot 토너먼트 콜백 페이로드 형태(최소 필드). 서버는 이 값을 신뢰하지 않고 match-v5로 재검증한다.
  const payload = {
    shortCode: code,
    gameId,
    region,
    metaData: JSON.stringify({ note: 'simulated callback' }),
    startTime: Date.now(),
  };

  console.log(`POST ${url}`);
  console.log('payload:', payload);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  console.log(`\n<- ${res.status} ${res.statusText}`);
  console.log(text);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
