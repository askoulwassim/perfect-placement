import type { HandlerMap } from '../runtime.js';
import { applyFill, applyMarkSubmitted, applyTailor, companiesDossierWrite } from './apply.js';
import { configGet, configUpdate } from './config.js';
import { inboxIngest } from './inbox.js';
import { companiesGet, vaultRead } from './reads.js';
import { pipelineSummary, rolesAdd, rolesArchive, rolesGet, rolesList, rolesMove } from './roles.js';
import { runsFinish, runsGet, runsList, runsStart } from './runs.js';

/** Every handler lane B owns. */
export const LANE_B_HANDLERS: HandlerMap = {
  'roles.add': rolesAdd,
  'roles.move': rolesMove,
  'roles.archive': rolesArchive,
  'roles.get': rolesGet,
  'roles.list': rolesList,
  'pipeline.summary': pipelineSummary,
  'companies.get': companiesGet,
  'companies.dossier.write': companiesDossierWrite,
  'apply.tailor': applyTailor,
  'apply.fill': applyFill,
  'apply.mark_submitted': applyMarkSubmitted,
  'inbox.ingest': inboxIngest,
  'runs.list': runsList,
  'runs.get': runsGet,
  'runs.start': runsStart,
  'runs.finish': runsFinish,
  'config.get': configGet,
  'config.update': configUpdate,
  'vault.read': vaultRead,
};

export { NOT_LANE_B } from './stubs.js';
