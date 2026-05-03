import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { Country, Player, SnapshotIndex } from '../models/player-data.model';

export interface CountryPlayers {
  country: Country;
  players: Player[];
}

export interface SnapshotMeta {
  date: string;
  generatedAt: string;
  complete: boolean;
  countryCount?: number;
  playerCount?: number;
  source?: string;
}

export interface SnapshotData {
  date: string;
  generatedAt: string;
  source?: string;
  countryPlayers: CountryPlayers[];
}

@Injectable({ providedIn: 'root' })
export class PlayerDataService {
  private readonly http = inject(HttpClient);

  // Caches survive across multiple loads — once a (date, code) file is fetched
  // we never hit the network for it again.
  private countriesCache?: Country[];
  private indexCache?: SnapshotIndex;
  private readonly metaCache = new Map<string, SnapshotMeta>();
  private readonly playerCache = new Map<string, Player[]>(); // key = `${date}:${code}`

  async loadIndex(): Promise<SnapshotIndex> {
    if (!this.indexCache) {
      this.indexCache = await firstValueFrom(
        this.http.get<SnapshotIndex>('data/snapshots/index.json'),
      );
    }
    return this.indexCache;
  }

  async loadCountries(): Promise<Country[]> {
    if (!this.countriesCache) {
      this.countriesCache = await firstValueFrom(
        this.http.get<Country[]>('data/countries.json'),
      );
    }
    return this.countriesCache;
  }

  async loadSnapshot(date: string): Promise<SnapshotData> {
    const [countries, meta] = await Promise.all([
      this.loadCountries(),
      this.loadMeta(date),
    ]);

    const results = await Promise.all(
      countries.map(async country => ({
        country,
        players: await this.loadCountryPlayers(date, country.code),
      })),
    );

    return {
      date,
      generatedAt: meta.generatedAt,
      source: meta.source,
      countryPlayers: results.filter(r => r.players.length > 0),
    };
  }

  async loadCountryAcrossDates(
    code: string,
    dates: string[],
  ): Promise<Map<string, Player[]>> {
    const result = new Map<string, Player[]>();
    await Promise.all(
      dates.map(async date => {
        result.set(date, await this.loadCountryPlayers(date, code));
      }),
    );
    return result;
  }

  private async loadMeta(date: string): Promise<SnapshotMeta> {
    const cached = this.metaCache.get(date);
    if (cached) return cached;
    const meta = await firstValueFrom(
      this.http.get<SnapshotMeta>(`data/snapshots/${date}/meta.json`),
    );
    this.metaCache.set(date, meta);
    return meta;
  }

  private async loadCountryPlayers(date: string, code: string): Promise<Player[]> {
    const key = `${date}:${code}`;
    const cached = this.playerCache.get(key);
    if (cached) return cached;
    let players: Player[] = [];
    try {
      players = await firstValueFrom(
        this.http.get<Player[]>(`data/snapshots/${date}/players/${code}.json`),
      );
    } catch {}
    this.playerCache.set(key, players);
    return players;
  }
}
