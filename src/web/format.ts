/**
 * Timestamps for display.
 *
 * The API sends ISO-8601 in UTC, because that is what a timestamptz serialises
 * to and it is the only format that is unambiguous on the wire. Nobody reads a
 * date that way, so it gets turned into the reader's own local time here, at
 * the last possible moment — the one place that knows where the reader is.
 */
export const when = (value: string | null | undefined): string => {
  if (!value) return ""
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return String(value)

  const sameYear = at.getFullYear() === new Date().getFullYear()
  return at.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    // A year on every row is noise when almost every row is this year.
    year: sameYear ? undefined : "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/** Date alone, for rows where the time of day carries nothing. */
export const day = (value: string | null | undefined): string => {
  if (!value) return ""
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return String(value)
  return at.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
}
