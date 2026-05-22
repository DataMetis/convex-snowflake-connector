/**
 * Snowflake identifier handling.
 *
 * snowflake-sdk wraps connection-option identifiers (database/schema/warehouse/
 * role) verbatim in double quotes when it issues `USE …`. Quoted identifiers
 * are case-sensitive in Snowflake; unquoted ones fold to upper case. So a
 * config that says `database: ihdb` ends up looking up a literal `"ihdb"` —
 * which doesn't exist, because the real database is `IHDB`.
 *
 * Anything matching the bare-identifier grammar (`[A-Za-z_][A-Za-z0-9_$]*`)
 * is uppercased so it behaves like the user typed it bare in SQL. Anything
 * with spaces, dots, or other special characters is left as-is — the user
 * has signaled they meant a quoted identifier.
 */
const BARE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export function normalizeIdentifier(value: string): string {
  return BARE_IDENTIFIER.test(value) ? value.toUpperCase() : value;
}
