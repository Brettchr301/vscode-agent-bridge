import * as http from 'http';

export interface ShellResult { stdout: string; stderr: string; code: number; }
export interface ChangeEntry  { path: string; ts: number; }
export interface WatchSession  { startTs: number; label: string; }

/** Every route handler receives this context object. */
export interface RouteContext {
  meth:    string;
  pathStr: string;
  qp:      Record<string, string>;
  b:       Record<string, unknown>;
  req:     http.IncomingMessage;
  res:     http.ServerResponse;
}

/** A route module returns true if it handled the request, false to pass through. */
export type RouteModule = (ctx: RouteContext) => Promise<boolean>;
