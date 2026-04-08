import type { SubagentConfig } from "./types.js";

export class SubagentRegistry {
  private readonly configs = new Map<string, SubagentConfig>();

  register(config: SubagentConfig): void {
    this.configs.set(config.name, config);
  }

  get(name: string): SubagentConfig | undefined {
    return this.configs.get(name);
  }

  list(): SubagentConfig[] {
    return [...this.configs.values()];
  }

  names(): string[] {
    return [...this.configs.keys()];
  }
}
