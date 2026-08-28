import type { PlotCommand } from "@silvic/contracts";
import {
  reserveRuntimeSidePort,
  type RuntimePortReservation,
} from "@silvic/core";

export type RuntimePortReservations = Record<
  string,
  Record<string, RuntimePortReservation>
>;

export interface RuntimePortReservationStore {
  read(): RuntimePortReservations;
  /** Electron Store writes synchronously; that is the reservation boundary. */
  write(reservations: RuntimePortReservations): void;
}

/**
 * Persist a command's reservation before startup can reach its first await.
 * Every caller re-reads the synchronously written state, so overlapping Start
 * requests cannot both claim a candidate that looked free.
 */
export function reserveRuntimePorts({
  store,
  workspaceId,
  commands,
  commandId,
  plotPort,
  claimedPlotPorts,
  activePorts = [],
}: {
  store: RuntimePortReservationStore;
  workspaceId: string;
  commands: Readonly<Record<string, PlotCommand>>;
  commandId: string;
  plotPort: number;
  claimedPlotPorts: readonly number[];
  activePorts?: readonly number[];
}): RuntimePortReservation {
  const persisted = store.read();
  const attemptPorts = persisted[workspaceId];
  const existing = attemptPorts?.[commandId];
  if (existing) return existing;

  const taken = new Set<number>([
    ...claimedPlotPorts,
    ...claimedPlotPorts.map((port) => port + 20_000),
    ...Object.values(persisted).flatMap((runtimeCommands) =>
      Object.values(runtimeCommands).flatMap((reservation) => [
        reservation.port,
        reservation.inspectorPort,
      ]),
    ),
    ...activePorts,
  ]);
  const primaryServingCommand = Object.entries(commands).find(
    ([, command]) => command.url === true,
  )?.[0];
  const identity = `${workspaceId}/${commandId}`;
  const reservation = {
    port:
      commandId === primaryServingCommand
        ? plotPort
        : reserveRuntimeSidePort(`${identity}/runtime`, taken),
    inspectorPort: reserveRuntimeSidePort(`${identity}/inspector`, taken),
  };
  store.write({
    ...persisted,
    [workspaceId]: {
      ...attemptPorts,
      [commandId]: reservation,
    },
  });
  return reservation;
}
