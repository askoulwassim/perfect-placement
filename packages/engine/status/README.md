# packages/engine/status

**Owner: lane B** (`docs/v2/lanes/`). Only lane B writes here.

Pure status machine, no db: `checkTransition({ from, to, actor, via })` for every path (`move`, `archive`, `tailor`, `submit`, `inbox`, `score`, `promote`), `isDowngrade` (no-downgrade out of `PROTECTED_STATUSES`), `MANUAL_MOVES` for humans, `freesSlot` + `pickPromotions` for held promotion under `config.scoring.company_active_cap`. Slots count `active` roles only.

Automated archiving out of a protected status is allowed for `rejected` (inbox) and for `closed` on a `draft-ready` role (freshness scope). Humans may restore an archived role to inbox, active or on-deck.
