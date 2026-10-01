export type PlayerIdentity = {
  playerCode: string;
  riotName: string;
  riotNameTag: string;
};

export type PeriodRecord = { totalCount: number; win: number; winRate: number };
export type RisingStar = PlayerIdentity & {
  previous: PeriodRecord;
  current: PeriodRecord;
  improvementPp: number;
};

export type HighlightCategory =
  | 'kills'
  | 'assists'
  | 'championDamage'
  | 'visionScore'
  | 'damageTaken'
  | 'buildingDamage';

export type HighlightEntry = PlayerIdentity & {
  champion: { champName: string; champNameEng: string };
  registeredDate: string;
  value: number;
};

export type PentakillEntry = PlayerIdentity & {
  champion: { champName: string; champNameEng: string };
  registeredDate: string;
  pentaKills: number;
};

export type Highlights = Record<
  HighlightCategory,
  { value: number | null; entries: HighlightEntry[] }
> & {
  pentakills: {
    totalPlayers: number;
    totalPentaKills: number;
    entries: PentakillEntry[];
  };
};

export type WinStreak = PlayerIdentity & {
  streak: number;
  latestRegisteredDate: string;
};
