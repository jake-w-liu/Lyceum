// Command registry: every UI action is registered as a runnable command.

export interface Command {
  id: string;
  title: string;
  category?: string;
  run: () => void | Promise<void>;
}

export class CommandRegistry {
  private commands = new Map<string, Command>();

  register(cmd: Command): void {
    this.commands.set(cmd.id, cmd);
  }

  get(id: string): Command | undefined {
    return this.commands.get(id);
  }

  list(): Command[] {
    return Array.from(this.commands.values());
  }

  async execute(id: string): Promise<void> {
    const cmd = this.commands.get(id);
    if (!cmd) {
      console.warn(`Unknown command: ${id}`);
      return;
    }
    await cmd.run();
  }

  clear(): void {
    this.commands.clear();
  }
}

export const commandRegistry = new CommandRegistry();
