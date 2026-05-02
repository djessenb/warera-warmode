import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { Country, Player } from '../models/player-data.model';

export const SKILL_LABELS: Record<string, string> = {
  health: 'Health',
  attack: 'Attack',
  criticalChance: 'Critical Chance',
  criticalDamages: 'Critical Damage',
  armor: 'Armor',
  precision: 'Precision',
  dodge: 'Dodge',
};

export interface CountryPlayers {
  country: Country;
  players: Player[];
}

@Injectable({ providedIn: 'root' })
export class PlayerDataService {
  private readonly http = inject(HttpClient);

  async loadAll(): Promise<CountryPlayers[]> {
    const countries = await firstValueFrom(this.http.get<Country[]>('data/countries.json'));

    const results = await Promise.all(
      countries.map(async country => {
        let players: Player[] = [];
        try {
          players = await firstValueFrom(this.http.get<Player[]>(`data/players/${country.code}.json`));
        } catch {}
        return { country, players };
      })
    );

    return results.filter(r => r.players.length > 0);
  }
}
