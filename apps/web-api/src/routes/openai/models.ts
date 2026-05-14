import { Hono } from 'hono';
import type { PersonalitiesService } from '../../services/personalities.service';

// `GET /v1/models` — OpenAI-shape catalog of agents the client can target.
// Personalities, registered teams (prefixed `team:`), and the `ethos-default`
// alias all appear here. Bearer auth is applied at the parent mount.

export interface OpenAiModelsRouteOptions {
  personalities: PersonalitiesService;
  /** Returns currently registered team names (no prefix). */
  listTeams?: () => Promise<string[]>;
}

export interface OpenAiModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

export interface OpenAiModelList {
  object: 'list';
  data: OpenAiModel[];
}

export function openAiModelsRoutes(opts: OpenAiModelsRouteOptions): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const personalities = opts.personalities.list().personalities;
    const teams = opts.listTeams ? await opts.listTeams() : [];
    const data: OpenAiModel[] = [
      ...personalities.map((p) => modelEntry(p.id)),
      ...teams.map((name) => modelEntry(`team:${name}`)),
      modelEntry('ethos-default'),
    ];
    const body: OpenAiModelList = { object: 'list', data };
    return c.json(body);
  });

  return app;
}

function modelEntry(id: string): OpenAiModel {
  return { id, object: 'model', created: 0, owned_by: 'ethos' };
}
