/*
 * Ops owned by lanes that are not merged yet (A, E, F, G, H, I) have no handler here:
 * `runOp` answers `unimplemented` ("owned by lane X, not merged yet") until the owning
 * lane registers its handler with `engine.register(name, handler)` in Wave 2.
 * `outreach.send` is `unimplemented` by contract and never gets a handler.
 */
export const NOT_LANE_B = [
  'profile.get',
  'profile.history',
  'profile.propose_diff',
  'profile.apply_diff',
  'profile.reject_diff',
  'onboard.ingest_resume',
  'onboard.answer',
  'onboard.calibrate',
  'onboard.confirm',
  'roles.score',
  'roles.check_freshness',
  'people.find',
  'people.link',
  'people.classify',
  'outreach.draft',
  'outreach.to_gmail',
  'outreach.send',
  'decisions.queue',
  'decisions.resolve',
  'decisions.undo',
  'system.doctor',
] as const;
