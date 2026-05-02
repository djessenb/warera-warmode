import { Component, computed, inject, signal, OnInit } from '@angular/core';
import { DecimalPipe, UpperCasePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { PlayerDataService, CountryPlayers, SKILL_LABELS } from '../services/player-data.service';
import { Player } from '../models/player-data.model';

export interface SkillThreshold {
  key: string;
  label: string;
  min: number;
}

interface CountryRow {
  countryId: string;
  countryName: string;
  countryCode: string;
  totalPlayers: number;
  filteredPlayers: number;
  skillAvgs: Record<string, number>;
}

@Component({
  selector: 'app-dashboard',
  imports: [DecimalPipe, UpperCasePipe, FormsModule],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard implements OnInit {
  private readonly service = inject(PlayerDataService);

  readonly loading = signal(true);
  readonly rawData = signal<CountryPlayers[]>([]);
  readonly skillKeys = Object.keys(SKILL_LABELS);
  readonly skillLabels = SKILL_LABELS;

  private readonly defaultThresholds: SkillThreshold[] = [
    { key: 'attack', label: 'Attack', min: 3 },
    { key: 'health', label: 'Health', min: 0 },
    { key: 'criticalChance', label: 'Crit Chance', min: 3 },
    { key: 'criticalDamages', label: 'Crit Damage', min: 3 },
    { key: 'precision', label: 'Precision', min: 3 },
  ];

  readonly thresholds = signal<SkillThreshold[]>(this.defaultThresholds.map(t => ({ ...t })));

  readonly onlyLvl20Plus = signal(true);
  readonly countrySearch = signal('');
  readonly selectedSkill = signal<string | null>(null);
  readonly sortColumn = signal<'country' | 'players' | 'filtered' | 'percent' | 'skill'>('filtered');
  readonly sortAsc = signal(false);

  readonly rows = computed<CountryRow[]>(() => {
    const data = this.rawData();
    const filters = this.thresholds();
    const lvl20 = this.onlyLvl20Plus();

    return data.map(({ country, players }) => {
      const pool = lvl20 ? players.filter(p => (p.level ?? 0) >= 20) : players;
      const matching = pool.filter(p => this.passesFilters(p, filters));

      const skillAvgs: Record<string, number> = {};
      for (const key of this.skillKeys) {
        if (matching.length === 0) {
          skillAvgs[key] = 0;
        } else {
          const total = matching.reduce((sum, p) => sum + (p.skills?.[key]?.level ?? 0), 0);
          skillAvgs[key] = total / matching.length;
        }
      }

      return {
        countryId: country._id,
        countryName: country.name,
        countryCode: country.code,
        totalPlayers: pool.length,
        filteredPlayers: matching.length,
        skillAvgs,
      };
    });
  });

  readonly sorted = computed(() => {
    const skill = this.selectedSkill();
    const col = this.sortColumn();
    const asc = this.sortAsc();

    const search = this.countrySearch().toLowerCase();

    return [...this.rows()]
      .filter(r => !search || r.countryName.toLowerCase().includes(search))
      .sort((a, b) => {
      let diff = 0;
      if (col === 'country') {
        diff = a.countryName.localeCompare(b.countryName);
      } else if (col === 'players') {
        diff = a.totalPlayers - b.totalPlayers;
      } else if (col === 'filtered') {
        diff = a.filteredPlayers - b.filteredPlayers;
      } else if (col === 'percent') {
        const pctA = a.totalPlayers > 0 ? a.filteredPlayers / a.totalPlayers : 0;
        const pctB = b.totalPlayers > 0 ? b.filteredPlayers / b.totalPlayers : 0;
        diff = pctA - pctB;
      } else if (col === 'skill' && skill) {
        diff = (a.skillAvgs[skill] ?? 0) - (b.skillAvgs[skill] ?? 0);
      }
      return asc ? diff : -diff;
    });
  });

  readonly totalPlayers = computed(() => this.rows().reduce((sum, r) => sum + r.totalPlayers, 0));
  readonly totalFiltered = computed(() => this.rows().reduce((sum, r) => sum + r.filteredPlayers, 0));
  readonly totalCountries = computed(() => this.rows().filter(r => r.filteredPlayers > 0).length);

  async ngOnInit() {
    const data = await this.service.loadAll();
    this.rawData.set(data);
    this.loading.set(false);
  }

  resetFilters() {
    this.thresholds.set(this.defaultThresholds.map(t => ({ ...t })));
    this.onlyLvl20Plus.set(true);
    this.countrySearch.set('');
    this.selectedSkill.set(null);
  }

  updateThreshold(index: number, value: number) {
    const clamped = Math.max(0, Math.min(10, value));
    this.thresholds.update(list => {
      const updated = [...list];
      updated[index] = { ...updated[index], min: clamped };
      return updated;
    });
  }

  selectSkill(skill: string) {
    this.selectedSkill.set(this.selectedSkill() === skill ? null : skill);
    if (this.selectedSkill()) {
      this.sortColumn.set('skill');
      this.sortAsc.set(false);
    }
  }

  sort(column: 'country' | 'players' | 'filtered' | 'percent' | 'skill') {
    if (this.sortColumn() === column) {
      this.sortAsc.update(v => !v);
    } else {
      this.sortColumn.set(column);
      this.sortAsc.set(column === 'country');
    }
  }

  getMaxFiltered(): number {
    return Math.max(1, ...this.rows().map(r => r.filteredPlayers));
  }

  getMaxForSkill(skill: string): number {
    return Math.max(1, ...this.rows().map(r => r.skillAvgs[skill] ?? 0));
  }

  barWidth(value: number, max: number): number {
    return max > 0 ? (value / max) * 100 : 0;
  }

  private passesFilters(player: Player, filters: SkillThreshold[]): boolean {
    for (const f of filters) {
      const level = player.skills?.[f.key]?.level ?? 0;
      if (level < f.min) return false;
    }
    return true;
  }
}
