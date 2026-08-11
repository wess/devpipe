/**
 * Saves bytes the app already has to a file on disk.
 *
 * Needed because the export routes are owner-only behind
 * `Authorization: Bearer`, and a plain `<a href>` is a navigation — no headers,
 * so the server refuses it and the browser cheerfully saves the 401 body under
 * the name you asked for. Fetching with the header and handing the result over
 * as a blob is the only shape that works without weakening the route.
 */
export const save = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Freed on the next turn rather than immediately: revoking synchronously
  // races the click in Safari and saves an empty file.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
