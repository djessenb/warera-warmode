export interface SkillData {
  level: number;
  total: number;
}

export interface Player {
  _id: string;
  username: string;
  level: number;
  skillPoints: number;
  skills: Record<string, SkillData>;
  militaryRank: number;
  createdAt: string;
}

export interface CountryRanking {
  value: number;
  rank: number;
  tier: string;
}

export interface Country {
  _id: string;
  name: string;
  code: string;
  development: number;
  money: number;
  rankings: Record<string, CountryRanking>;
}

export interface CountrySkillSummary {
  country: Country;
  playerCount: number;
  skillDistribution: Record<string, { totalLevels: number; playersWithSkill: number; avgLevel: number }>;
}
