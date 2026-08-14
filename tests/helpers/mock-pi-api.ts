/**
 * Mock pi ExtensionAPI and ExtensionContext for testing index.ts.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface MockPiScope {
  api: ExtensionAPI;
  ctx: ExtensionContext;
  /** Recorded tool registrations */
  tools: Map<string, { execute: (...args: unknown[]) => unknown }>;
  /** Recorded event handlers keyed by event name */
  handlers: Map<string, Array<(...args: unknown[]) => unknown>>;
  /** Recorded command handlers keyed by command name */
  commands: Map<string, { description: string; handler: (...args: unknown[]) => unknown }>;
  /** Recorded flags keyed by flag name */
  flags: Map<string, { description: string; type: string; value?: unknown }>;
  /** UI notification history */
  notifications: Array<{ message: string; level: string }>;
  /** UI status entries */
  statusEntries: Array<{ key: string; value: string | undefined }>;
  /** Simulate setting a flag value */
  setFlag: (name: string, value: unknown) => void;
  /** Get a handler by event name */
  getHandler: (event: string) => ((...args: unknown[]) => unknown) | undefined;
  /** Trigger an event with given args */
  triggerEvent: (event: string, ...args: unknown[]) => Promise<void>;
  /** Trigger a command with given args */
  triggerCommand: (command: string, args?: string) => Promise<void>;
}

export function createMockPi(): MockPiScope {
  const tools = new Map<string, { execute: (...args: unknown[]) => unknown }>();
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const commands = new Map<string, { description: string; handler: (...args: unknown[]) => unknown }>();
  const flags = new Map<string, { description: string; type: string; value?: unknown }>();
  const notifications: Array<{ message: string; level: string }> = [];
  const statusEntries: Array<{ key: string; value: string | undefined }> = [];
  const flagValues = new Map<string, unknown>();

  const theme = {
    fg: (color: string, text: string) => text,
    bold: (text: string) => text,
  };

  const ui = {
    notify: (message: string, level?: string) => {
      notifications.push({ message, level: level ?? "info" });
    },
    setStatus: (key: string, value: string | undefined) => {
      statusEntries.push({ key, value });
    },
    theme,
  };

  const sessionManager = {
    getSessionId: () => "test-session-id",
    getSessionFile: () => "/tmp/test-session.json",
  };

  const ctx = {
    ui,
    sessionManager,
    model: { provider: "test", id: "test-model" },
    thinkingLevel: "low" as const,
  } as unknown as ExtensionContext;

  const api: ExtensionAPI = {
    registerFlag: (name: string, opts: { description: string; type: string }) => {
      flags.set(name, { ...opts, value: flagValues.get(name) });
    },
    getFlag: (name: string) => flagValues.get(name),
    registerTool: (tool: { name: string; execute: (...args: unknown[]) => unknown; parameters?: Record<string, unknown> }) => {
      tools.set(tool.name, { execute: tool.execute });
    },
    registerCommand: (name: string, opts: { description: string; handler: (...args: unknown[]) => unknown }) => {
      commands.set(name, opts);
    },
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  } as unknown as ExtensionAPI;

  return {
    api,
    ctx,
    tools,
    handlers,
    commands,
    flags,
    notifications,
    statusEntries,
    setFlag: (name, value) => {
      flagValues.set(name, value);
      const existing = flags.get(name);
      if (existing) existing.value = value;
    },
    getHandler: (event) => {
      const h = handlers.get(event);
      return h ? h[h.length - 1] : undefined;
    },
    triggerEvent: async (event, ...args) => {
      const h = handlers.get(event);
      if (!h) return;
      for (const handler of h) {
        await handler(...args, ctx);
      }
    },
    triggerCommand: async (command, args) => {
      const cmd = commands.get(command);
      if (!cmd) throw new Error(`Command "${command}" not registered`);
      await cmd.handler(args ?? "", ctx);
    },
  };
}
