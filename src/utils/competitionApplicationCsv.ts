import { CompetitionApplicationItem } from '../types/competition.js';

type CsvApplication = Pick<
  CompetitionApplicationItem,
  | 'riotName'
  | 'riotNameTag'
  | 'mainPosition'
  | 'subPositions'
  | 'champions'
  | 'availableTime'
  | 'captainAvailable'
  | 'practiceLevel'
  | 'comment'
>;

const positionNames: Record<string, string> = {
  TOP: '탑',
  JUG: '정글',
  MID: '미드',
  ADC: '원딜',
  SUP: '서폿',
  ALL: '전체',
};

const practiceNames: Record<string, string> = {
  NONE: '거의없음',
  RARE: '가끔',
  MODERATE: '적당히',
  OFTEN: '자주',
  ACTIVE: '적극적',
};

/** CSV 구문과 스프레드시트 수식 실행을 모두 막는다. */
const csvCell = (value: string): string => {
  const singleLine = value.replace(/\s*[\r\n]+\s*/g, ' ');
  const safe =
    /^\s*[=+\-@]/.test(singleLine) || /^[\t\r\n]/.test(singleLine) ? `'${singleLine}` : singleLine;
  return `"${safe.replace(/"/g, '""')}"`;
};

export const competitionApplicationsCsv = (applications: CsvApplication[]): string => {
  const header = [
    '라이엇 이름',
    '태그',
    '주 포지션',
    '부 포지션',
    '챔피언',
    '가능 시간',
    '팀장 가능',
    '연습량',
    '한마디',
  ];
  const rows = [...applications]
    .sort(
      (a, b) =>
        a.riotName.localeCompare(b.riotName, 'ko') ||
        a.riotNameTag.localeCompare(b.riotNameTag, 'ko'),
    )
    .map((application) => [
      application.riotName,
      application.riotNameTag,
      positionNames[application.mainPosition] ?? application.mainPosition,
      application.subPositions.map((position) => positionNames[position] ?? position).join(', '),
      application.champions.map((champion) => champion.champName).join(', '),
      application.availableTime ?? '',
      application.captainAvailable ? 'O' : 'X',
      practiceNames[application.practiceLevel] ?? application.practiceLevel,
      application.comment ?? '',
    ]);

  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
};
