import type { Store } from '../state/store.ts';
import type { Clock } from '../clock.ts';
import { parseTemplate, type TemplateInput } from '../contracts/template.ts';
import type { ServiceConfig } from '../config.ts';
import { notFound, stateConflict } from '../errors.ts';

/** Template registry: validates and persists environment templates. */
export class TemplateRegistry {
  private store: Store;
  private clock: Clock;
  private cfg: ServiceConfig;
  constructor(store: Store, clock: Clock, cfg: ServiceConfig) {
    this.store = store;
    this.clock = clock;
    this.cfg = cfg;
  }

  register(body: unknown): TemplateInput {
    const t = parseTemplate(body, this.cfg);
    if (this.store.getTemplate(t.name)) {
      throw stateConflict("template '" + t.name + "' already exists", t.name);
    }
    this.store.saveTemplate(t, this.clock.now());
    return t;
  }

  get(name: string): TemplateInput {
    const t = this.store.getTemplate(name);
    if (!t) throw notFound('template ' + name);
    return t;
  }

  list(): TemplateInput[] {
    return this.store.listTemplates();
  }
}
