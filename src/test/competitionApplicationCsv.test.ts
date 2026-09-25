import { describe, expect, test } from '@jest/globals';
import { competitionApplicationsCsv } from '../utils/competitionApplicationCsv.js';

describe('competitionApplicationsCsv', () => {
  test('한글 이름을 입력 순서대로 매핑하고 CSV 특수문자를 이스케이프한다', () => {
    const csv = competitionApplicationsCsv([
      {
        riotName: '=SUM(1,2)',
        riotNameTag: 'KR1',
        mainPosition: 'JUG',
        subPositions: ['MID', 'ALL'],
        champions: [
          { id: 'Ahri', champName: '아리', champNameEng: 'Ahri', riotKey: 103 },
          { id: 'Aatrox', champName: '아트록스', champNameEng: 'Aatrox', riotKey: 266 },
        ],
        availableTime: '금요일, 21시',
        captainAvailable: true,
        practiceLevel: 'ACTIVE',
        comment: '안녕, "팀"\n잘 부탁드립니다',
      },
    ]);

    expect(csv).toBe(
      '\uFEFF"라이엇 이름","태그","주 포지션","부 포지션","챔피언","가능 시간","팀장 가능","연습량","한마디"\r\n' +
        '"\'=SUM(1,2)","KR1","정글","미드, 전체","아리, 아트록스","금요일, 21시","O","적극적","안녕, ""팀"" 잘 부탁드립니다"\r\n',
    );
  });

  test('팀장 불가능은 X로 표시한다', () => {
    const csv = competitionApplicationsCsv([
      {
        riotName: '테스트',
        riotNameTag: 'KR1',
        mainPosition: 'TOP',
        subPositions: [],
        champions: [],
        availableTime: null,
        captainAvailable: false,
        practiceLevel: 'NONE',
        comment: null,
      },
    ]);

    expect(csv).toContain('"테스트","KR1","탑","","","","X","거의없음",""');
  });

  test('신청자가 없어도 헤더가 있는 CSV를 만든다', () => {
    expect(competitionApplicationsCsv([])).toContain('"라이엇 이름","태그"');
  });
});
