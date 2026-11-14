# scripts/data/

Static reference data consumed by `scripts/generate-states-config.js`.

## `us-counties.csv`

Two columns, no header: USPS state code, county (or county-equivalent) name
as-is (including the "County"/"Parish"/"Borough"/etc. suffix, which the
generator strips). Covers all 50 states plus DC (DC's single row is currently
ignored by the generator - see `STATE_NAMES` there).

Derived from a public, Census-based state/county FIPS code reference
(`state_and_county_fips_master.csv`, commonly mirrored at
https://github.com/kjhealy/fips-codes), trimmed down to just the two columns
needed here. Florida's rows in this file are intentionally **not** used by
the generator - Florida's county codes come from `httpdocs/index.html`
instead, since real cave IDs already depend on those exact codes.

If a state's county list ever needs correcting, either edit this file
directly (state,name per line) and re-run the generator, or replace it
wholesale with a fresher pull from an authoritative source - the generator
doesn't care where the file came from, only its two-column shape.
