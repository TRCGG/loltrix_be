export interface ChampionListItem {
  id: string;
  champName: string;
  champNameEng: string;
  riotKey: number | null;
}

export interface ChampionListAPIResponse {
  status: 'success' | 'error';
  message: string;
  data?: ChampionListItem[] | null;
}
