import {
  Component, computed, effect, ElementRef, inject, OnDestroy, OnInit,
  signal, viewChild,
} from '@angular/core';
import { DecimalPipe, SlicePipe, UpperCasePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import flatpickr from 'flatpickr';
import { PlayerDataService, SnapshotData } from '../services/player-data.service';
import {
  Player,
  Country,
  COMBAT_SKILLS,
  SKILL_INDEX,
  SKILL_LABELS,
  SkillKey,
} from '../models/player-data.model';

export interface SkillThreshold {
  key: SkillKey;
  label: string;
  min: number;
}

interface CountryRow {
  countryCode: string;
  countryName: string;
  totalPlayers: number;
  filteredPlayers: number;
  delta: number | null;
  skillAvgs: Record<SkillKey, number>;
}

interface ChartPoint {
  date: string;
  ready: number;
  pool: number;
  x: number;
  yReady: number;
  yPool: number;
}

interface ChartModel {
  width: number;
  height: number;
  padTop: number;
  padBottom: number;
  padLeft: number;
  padRight: number;
  yMax: number;
  yTicks: { y: number; label: string }[];
  points: ChartPoint[];
  readyPath: string;
  poolPath: string;
  readyArea: string;
}

const DAYS_OPTIONS = [
  { label: 'ANY', value: 0 },
  { label: '24H', value: 1 },
  { label: '7D', value: 7 },
  { label: '30D', value: 30 },
  { label: '90D', value: 90 },
] as const;

const MAX_RANGE_DAYS = 31;

@Component({
  selector: 'app-dashboard',
  imports: [DecimalPipe, SlicePipe, UpperCasePipe, FormsModule],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard implements OnInit, OnDestroy {
  private readonly service = inject(PlayerDataService);

  // Flatpickr inputs and instances
  private readonly startInput = viewChild<ElementRef<HTMLInputElement>>('startInput');
  private readonly endInput = viewChild<ElementRef<HTMLInputElement>>('endInput');
  private startPicker?: flatpickr.Instance;
  private endPicker?: flatpickr.Instance;

  readonly loading = signal(true);
  readonly availableDates = signal<string[]>([]);
  readonly startDate = signal<string>('');
  readonly endDate = signal<string>('');

  readonly startData = signal<SnapshotData | null>(null);
  readonly endData = signal<SnapshotData | null>(null);

  readonly expandedCountry = signal<string | null>(null);
  readonly timelineRaw = signal<Map<string, Player[]> | null>(null);
  readonly loadingTimeline = signal(false);

  // Metadata for the most recent complete snapshot. Independent of the picker
  // so the header "LAST UPDATE" always reflects the latest data we hold,
  // even if the operator picks an earlier end date.
  readonly latestMeta = signal<{ date: string; generatedAt: string; source?: string } | null>(null);

  readonly combatSkills = COMBAT_SKILLS;
  readonly skillLabels = SKILL_LABELS;
  readonly daysOptions = DAYS_OPTIONS;

  private readonly defaultThresholds: SkillThreshold[] = [
    { key: 'attack', label: 'ATK', min: 3 },
    { key: 'health', label: 'HP', min: 0 },
    { key: 'criticalChance', label: 'C.CHN', min: 3 },
    { key: 'criticalDamages', label: 'C.DMG', min: 3 },
    { key: 'precision', label: 'PRC', min: 3 },
  ];

  readonly thresholds = signal<SkillThreshold[]>(this.defaultThresholds.map(t => ({ ...t })));
  readonly onlyLvl20Plus = signal(true);
  readonly activeWithinDays = signal<number>(7);
  readonly countrySearch = signal('');
  readonly selectedSkill = signal<SkillKey | null>(null);
  readonly sortColumn = signal<'country' | 'filtered' | 'delta' | 'percent' | 'skill'>('filtered');
  readonly sortAsc = signal(false);

  readonly hasComparison = computed(() => this.startDate() !== this.endDate());

  readonly datesInRange = computed<string[]>(() => {
    const s = this.startDate();
    const e = this.endDate();
    if (!s || !e) return [];
    return this.availableDates().filter(d => d >= s && d <= e);
  });

  readonly daysInRange = computed(() => this.datesInRange().length);

  readonly rangeError = computed<string | null>(() => {
    const s = this.startDate();
    const e = this.endDate();
    if (!s || !e) return null;
    if (s > e) return 'Start date must be before end date';
    const diffDays = (new Date(e).getTime() - new Date(s).getTime()) / 86_400_000;
    if (diffDays > MAX_RANGE_DAYS) return `Window may not exceed ${MAX_RANGE_DAYS} days`;
    return null;
  });

  readonly hasActivityData = computed(() => {
    const end = this.endData();
    if (!end) return false;
    return end.countryPlayers.some(({ players }) => players.some(p => p.la !== null));
  });

  readonly rows = computed<CountryRow[]>(() => {
    const end = this.endData();
    if (!end) return [];
    const filters = this.thresholds();
    const lvl20 = this.onlyLvl20Plus();
    const days = this.activeWithinDays();
    const endCutoff = cutoffFor(end.generatedAt, end.date, days);

    const startMap = new Map<string, Player[]>();
    const start = this.startData();
    if (start && this.hasComparison()) {
      for (const cp of start.countryPlayers) {
        startMap.set(cp.country.code, cp.players);
      }
    }
    const startCutoff = start ? cutoffFor(start.generatedAt, start.date, days) : 0;

    return end.countryPlayers.map(({ country, players }) => {
      const endStats = this.computeStats(players, filters, lvl20, endCutoff);
      const startStats = this.hasComparison()
        ? this.computeStats(startMap.get(country.code) ?? [], filters, lvl20, startCutoff)
        : null;

      return {
        countryCode: country.code,
        countryName: country.name,
        totalPlayers: endStats.pool,
        filteredPlayers: endStats.matching,
        delta: startStats ? endStats.matching - startStats.matching : null,
        skillAvgs: endStats.skillAvgs,
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
        } else if (col === 'filtered') {
          diff = a.filteredPlayers - b.filteredPlayers;
        } else if (col === 'delta') {
          diff = (a.delta ?? 0) - (b.delta ?? 0);
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
  readonly visibleCountries = computed(() => this.sorted().filter(r => r.filteredPlayers > 0).length);

  readonly tableColumnCount = computed(() =>
    3 + (this.hasComparison() ? 1 : 0) + this.combatSkills.length,
  );

  // Build timeline chart model from cached per-day player arrays applying current filters.
  readonly chart = computed<ChartModel | null>(() => {
    const raw = this.timelineRaw();
    if (!raw || raw.size === 0) return null;
    const filters = this.thresholds();
    const lvl20 = this.onlyLvl20Plus();
    const days = this.activeWithinDays();

    const series = [...raw.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, players]) => {
        const stats = this.computeStats(players, filters, lvl20, cutoffFor(null, date, days));
        return { date, ready: stats.matching, pool: stats.pool };
      });

    const width = 720;
    const height = 220;
    const padLeft = 44, padRight = 24, padTop = 18, padBottom = 32;
    const innerW = width - padLeft - padRight;
    const innerH = height - padTop - padBottom;

    const yMaxRaw = Math.max(1, ...series.map(s => s.pool));
    const yMax = niceCeil(yMaxRaw);

    const xFor = (i: number) =>
      series.length === 1
        ? padLeft + innerW / 2
        : padLeft + (i * innerW) / (series.length - 1);
    const yFor = (v: number) => padTop + innerH - (v / yMax) * innerH;

    const points: ChartPoint[] = series.map((s, i) => ({
      date: s.date,
      ready: s.ready,
      pool: s.pool,
      x: xFor(i),
      yReady: yFor(s.ready),
      yPool: yFor(s.pool),
    }));

    const ticks = niceTicks(yMax, 4);
    const yTicks = ticks.map(v => ({ y: yFor(v), label: formatNum(v) }));

    const readyPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.yReady.toFixed(1)}`).join(' ');
    const poolPath  = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.yPool.toFixed(1)}`).join(' ');
    const readyArea = points.length === 1
      ? ''
      : `M ${points[0].x.toFixed(1)} ${(padTop + innerH).toFixed(1)} ` +
        points.map(p => `L ${p.x.toFixed(1)} ${p.yReady.toFixed(1)}`).join(' ') +
        ` L ${points.at(-1)!.x.toFixed(1)} ${(padTop + innerH).toFixed(1)} Z`;

    return {
      width, height, padTop, padBottom, padLeft, padRight,
      yMax, yTicks, points, readyPath, poolPath, readyArea,
    };
  });

  constructor() {
    // Init/refresh flatpickr instances when both inputs are in the DOM
    // (after `loading` flips to false) and we know which dates are allowed.
    effect(() => {
      const dates = this.availableDates();
      const startEl = this.startInput()?.nativeElement;
      const endEl = this.endInput()?.nativeElement;
      const start = this.startDate();
      const end = this.endDate();
      if (!startEl || !endEl || dates.length === 0) return;

      this.startPicker?.destroy();
      this.endPicker?.destroy();

      const baseConfig: flatpickr.Options.Options = {
        dateFormat: 'Y-m-d',
        enable: dates,
        disableMobile: true,
        altInput: true,
        altFormat: 'M j, Y',
        minDate: dates[0],
        maxDate: dates.at(-1),
      };

      this.startPicker = flatpickr(startEl, {
        ...baseConfig,
        defaultDate: start || dates.at(-1),
        onChange: (_d, dateStr) => { if (dateStr) this.setStartDate(dateStr); },
      });
      this.endPicker = flatpickr(endEl, {
        ...baseConfig,
        defaultDate: end || dates.at(-1),
        onChange: (_d, dateStr) => { if (dateStr) this.setEndDate(dateStr); },
      });
    });
  }

  async ngOnInit() {
    const index = await this.service.loadIndex();
    const dates = index.snapshots ?? [];
    this.availableDates.set(dates);
    if (dates.length === 0) {
      this.loading.set(false);
      return;
    }

    const latest = dates[dates.length - 1];
    this.endDate.set(latest);

    // Default the start date to the earliest available date within a 1-week
    // window from `latest`. This gives the widest meaningful comparison out
    // of the box without exceeding the 31-day max range. When a precise
    // 7-days-back date isn't in the snapshot list, we fall back to the
    // earliest available date that is still within the week.
    const weekBefore = new Date(latest);
    weekBefore.setUTCDate(weekBefore.getUTCDate() - 7);
    const weekBeforeStr = weekBefore.toISOString().slice(0, 10);
    const withinWindow = dates.filter(d => d >= weekBeforeStr);
    this.startDate.set(withinWindow[0] ?? latest);

    await this.reloadSnapshots();

    // Cache the latest snapshot's metadata so the header always reflects the
    // newest data we have, regardless of which dates the operator picks.
    const endSnap = this.endData();
    if (endSnap) {
      this.latestMeta.set({
        date: endSnap.date,
        generatedAt: endSnap.generatedAt,
        source: endSnap.source,
      });
    }

    if (!this.hasActivityData()) this.activeWithinDays.set(0);
    this.loading.set(false);
  }

  ngOnDestroy() {
    this.startPicker?.destroy();
    this.endPicker?.destroy();
  }

  async setStartDate(date: string) {
    if (!date) return;
    this.startDate.set(date);
    if (this.startDate() > this.endDate()) this.endDate.set(date);
    this.collapseTimeline();
    await this.reloadSnapshots();
  }

  async setEndDate(date: string) {
    if (!date) return;
    this.endDate.set(date);
    if (this.endDate() < this.startDate()) this.startDate.set(date);
    this.collapseTimeline();
    await this.reloadSnapshots();
  }

  private async reloadSnapshots() {
    const start = this.startDate();
    const end = this.endDate();
    if (!start || !end) return;

    const [endSnap, startSnap] = await Promise.all([
      this.service.loadSnapshot(end),
      start === end ? Promise.resolve(null) : this.service.loadSnapshot(start),
    ]);

    this.endData.set(endSnap);
    this.startData.set(startSnap);
  }

  async expandCountry(code: string) {
    if (this.expandedCountry() === code) {
      this.collapseTimeline();
      return;
    }
    this.expandedCountry.set(code);
    this.timelineRaw.set(null);

    const dates = this.datesInRange();
    if (dates.length === 0) return;

    this.loadingTimeline.set(true);
    try {
      const data = await this.service.loadCountryAcrossDates(code, dates);
      if (this.expandedCountry() === code) this.timelineRaw.set(data);
    } finally {
      this.loadingTimeline.set(false);
    }
  }

  collapseTimeline() {
    this.expandedCountry.set(null);
    this.timelineRaw.set(null);
  }

  resetFilters() {
    this.thresholds.set(this.defaultThresholds.map(t => ({ ...t })));
    this.onlyLvl20Plus.set(true);
    this.activeWithinDays.set(this.hasActivityData() ? 7 : 0);
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

  selectSkill(skill: SkillKey) {
    this.selectedSkill.set(this.selectedSkill() === skill ? null : skill);
    if (this.selectedSkill()) {
      this.sortColumn.set('skill');
      this.sortAsc.set(false);
    }
  }

  sort(column: 'country' | 'filtered' | 'delta' | 'percent') {
    if (this.sortColumn() === column) {
      this.sortAsc.update(v => !v);
    } else {
      this.sortColumn.set(column);
      this.sortAsc.set(column === 'country');
    }
  }

  sortLabel(): string {
    const col = this.sortColumn();
    if (col === 'skill' && this.selectedSkill()) {
      return this.skillLabels[this.selectedSkill()!];
    }
    if (col === 'country') return 'NATION';
    if (col === 'filtered') return 'READY';
    if (col === 'delta') return 'Δ';
    if (col === 'percent') return '%';
    return col;
  }

  formatDelta(d: number | null): string {
    if (d === null || d === 0) return '±0';
    return d > 0 ? `+${d}` : `${d}`;
  }

  private computeStats(
    players: Player[],
    filters: SkillThreshold[],
    lvl20: boolean,
    cutoff: number,
  ) {
    const pool = players.filter(p => {
      if (lvl20 && p.l < 20) return false;
      if (cutoff > 0 && p.la !== null && new Date(p.la).getTime() < cutoff) return false;
      return true;
    });
    const matching = pool.filter(p => this.passesFilters(p, filters));
    const skillAvgs = {} as Record<SkillKey, number>;
    for (const key of this.combatSkills) {
      const idx = SKILL_INDEX[key];
      skillAvgs[key] = matching.length === 0
        ? 0
        : matching.reduce((sum, p) => sum + (p.s[idx] ?? 0), 0) / matching.length;
    }
    return { pool: pool.length, matching: matching.length, skillAvgs };
  }

  private passesFilters(player: Player, filters: SkillThreshold[]): boolean {
    for (const f of filters) {
      const idx = SKILL_INDEX[f.key];
      const level = player.s[idx] ?? 0;
      if (level < f.min) return false;
    }
    return true;
  }
}

// Anchor the "ACTIVE WITHIN" cutoff to each snapshot's own time, not wall-clock.
// Using Date.now() makes historical snapshots filter out everyone (every `la`
// in a 7-day-old snapshot predates "now - 7d"), which breaks deltas and the
// timeline chart. Prefer generatedAt; fall back to the date's UTC midnight.
function cutoffFor(generatedAt: string | null | undefined, date: string, days: number): number {
  if (days <= 0) return 0;
  const anchor = generatedAt ? Date.parse(generatedAt) : Date.parse(`${date}T00:00:00Z`);
  return anchor - days * 86_400_000;
}

// Round 17 → 20, 234 → 250, etc. Picks a "nice" axis ceiling.
function niceCeil(v: number): number {
  if (v <= 5) return 5;
  if (v <= 10) return 10;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / exp;
  const niceM = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  return niceM * exp;
}

function niceTicks(max: number, count: number): number[] {
  const step = max / count;
  return Array.from({ length: count + 1 }, (_, i) => Math.round(i * step));
}

function formatNum(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + 'k';
  return String(n);
}
