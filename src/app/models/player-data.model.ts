// Slim per-player record produced by scripts/gather-data.mjs.
// `s` is positional — index meanings live in SKILL_ORDER below.
export interface Player {
  l: number;            // account level
  r: number;            // military rank
  la: string | null;    // dates.lastConnectionAt (ISO) — null for backfilled data
  s: number[];          // skill levels in SKILL_ORDER
}

export interface Country {
  name: string;
  code: string;
}

// Skill order matches scripts/gather-data.mjs SKILL_ORDER. DO NOT REORDER.
export const SKILL_ORDER = [
  'energy',
  'health',
  'hunger',
  'attack',
  'companies',
  'entrepreneurship',
  'production',
  'criticalChance',
  'criticalDamages',
  'armor',
  'precision',
  'dodge',
  'lootChance',
  'management',
] as const;

export type SkillKey = typeof SKILL_ORDER[number];

export const SKILL_INDEX: Record<SkillKey, number> = SKILL_ORDER.reduce(
  (acc, key, idx) => ({ ...acc, [key]: idx }),
  {} as Record<SkillKey, number>,
);

export const SKILL_LABELS: Record<SkillKey, string> = {
  energy: 'Energy',
  health: 'Health',
  hunger: 'Hunger',
  attack: 'Attack',
  companies: 'Companies',
  entrepreneurship: 'Entrepreneurship',
  production: 'Production',
  criticalChance: 'Crit Chance',
  criticalDamages: 'Crit Damage',
  armor: 'Armor',
  precision: 'Precision',
  dodge: 'Dodge',
  lootChance: 'Loot Chance',
  management: 'Management',
};

// Combat-relevant skills shown in the war-readiness table.
export const COMBAT_SKILLS: SkillKey[] = [
  'health', 'attack', 'criticalChance', 'criticalDamages',
  'armor', 'precision', 'dodge',
];

export interface SnapshotIndex {
  snapshots: string[];
  latest: string | null;
}
