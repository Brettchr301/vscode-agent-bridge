import { ChangeEntry, WatchSession } from './types';

/** Bridge-wide mutable state — single source of truth. */
export const logEntries: string[] = [];
export const chlog:      ChangeEntry[] = [];
export const sessions = new Map<string, WatchSession>();

export let autoDismissTimer: NodeJS.Timeout | null = null;
export const setAutoDismissTimer = (t: NodeJS.Timeout | null) => { autoDismissTimer = t; };

export const PORT_START = 3131;
export let   activePort = PORT_START;
export const setActivePort = (p: number) => { activePort = p; };

export const MAX_LOG = 500;
export const LOG_DIR = process.env.APPDATA
  ? require('path').join(process.env.APPDATA, 'AgentBridge')
  : '/tmp';
