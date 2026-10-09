import type { HandlerMap } from '../runtime.js';
import { applyMarkSubmitted, applySkipConnect, applyTailor, companiesDossierWrite } from './apply.js';
import { applyResolveClaim } from './claims.js';
import { configGet, configUpdate } from './config.js';
import { applyFill, applySetQuestions } from './fill.js';
import { inboxIngest } from './inbox.js';
import { companiesGet, vaultRead } from './reads.js';
import {
  pipelineSummary,
  rolesAdd,
  rolesArchive,
  rolesGet,
  rolesList,
  rolesMove,
  scoutPlanHandler,
  scoutWatchlistScanHandler,
} from './roles.js';
import { runsDispatch, runsFinish, runsGet, runsList, runsStart } from './runs.js';
import { schedulesStatus } from './schedules.js';

/** Every handler lane B owns. */
export const LANE_B_HANDLERS: HandlerMap = {
  'roles.add': rolesAdd,
  'scout.plan': scoutPlanHandler,
  'scout.watchlist_scan': scoutWatchlistScanHandler,
  'roles.move': rolesMove,
  'roles.archive': rolesArchive,
  'roles.get': rolesGet,
  'roles.list': rolesList,
  'pipeline.summary': pipelineSummary,
  'companies.get': companiesGet,
  'companies.dossier.write': companiesDossierWrite,
  'apply.tailor': applyTailor,
  'apply.fill': applyFill,
  'apply.set_questions': applySetQuestions,
  'apply.resolve_claim': applyResolveClaim,
  'apply.mark_submitted': applyMarkSubmitted,
  'apply.skip_connect': applySkipConnect,
  'inbox.ingest': inboxIngest,
  'runs.list': runsList,
  'runs.get': runsGet,
  'runs.start': runsStart,
  'runs.finish': runsFinish,
  'runs.dispatch': runsDispatch,
  'schedules.status': schedulesStatus,
  'config.get': configGet,
  'config.update': configUpdate,
  'vault.read': vaultRead,
};
