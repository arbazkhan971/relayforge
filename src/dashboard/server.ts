import type { LoadedConfig } from "../config/load.js";
import {
  startControlService,
  type ControlServiceHandle,
  type StartControlServiceOptions
} from "../control/service.js";
import { CONTROL_HOST } from "../control/protocol.js";

/** Compatibility name for callers that displayed the old dashboard bind address. */
export const DASHBOARD_HOST = CONTROL_HOST;

export type DashboardStartOptions = {
  project?: string;
  port?: number;
  /** In-process run owners lend canonical stores instead of opening a second handle. */
  borrowedSources?: StartControlServiceOptions["borrowedSources"];
};

/**
 * The dashboard is no longer a parallel legacy server. It is the root document of the exact same
 * lifetime-owned, loopback-only control service that serves versioned REST and durable SSE.
 */
export function startDashboard(
  loaded: LoadedConfig,
  options: DashboardStartOptions = {}
): Promise<ControlServiceHandle> {
  return startControlService(loaded, {
    port: options.port,
    dashboardProject: options.project,
    borrowedSources: options.borrowedSources
  });
}
