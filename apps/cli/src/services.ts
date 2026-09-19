import { EventLedger, WorkspaceService, parseLedgerKey } from '@knoverge/core';
import {
  createActorRepository,
  createDatabase,
  createEventRepository,
  createUnitOfWork,
  createWorkspaceRepository,
} from '@knoverge/db';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/**
 * Composition root for CLI commands: database, repositories, ledger, services.
 */
export function createServices() {
  const database = createDatabase({ connectionString: required('KNOVERGE_DATABASE_URL'), max: 2 });
  const repositories = {
    events: createEventRepository(database.db),
    workspaces: createWorkspaceRepository(database.db),
    actors: createActorRepository(database.db),
  };
  const ledger = new EventLedger({
    key: parseLedgerKey(required('KNOVERGE_LEDGER_KEY')),
    events: repositories.events,
  });
  const workspaces = new WorkspaceService({
    uow: createUnitOfWork(database.db),
    workspaces: repositories.workspaces,
    actors: repositories.actors,
    ledger,
  });
  return {
    repositories,
    ledger,
    workspaces,
    close: () => database.close(),
  };
}
