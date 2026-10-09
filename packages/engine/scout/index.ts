// Scout mechanics (#28, #32): watchlist ATS scan, title / work-mode rule filter, intake verification.
export { aggregatorOf } from './aggregator.js';
export { type BoardFound, type BoardSearch, boardCandidates, type CompanyHint, findBoard } from './boards.js';
export { levelOf, type ProfileForScan, rulesFromProfile, type ScanRules, type ScreenReason, screen } from './filter.js';
export { type IntakeDeps, type IntakeVerdict, intakeDeps, matchPosting, RESOLVE_TITLE_MIN, verifyCandidate } from './intake.js';
export { cutCompany, type FitProfile, type FitScorer, fitScorer, GROUP_TITLE_MIN, interleave, rankByFit } from './rank.js';
export { type Known, type ScanCandidate, type ScanCompany, type ScanResult, scanWatchlist } from './watchlist.js';
