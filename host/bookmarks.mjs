// Room profiles start with no toolbar bookmarks. The landing page is the site
// list, so the Chromium and Zen writers share an empty set.
export const SITES = [];

const escape = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');

// Gecko imports this Netscape format once, when the profile has no places
// database. An empty toolbar leaves a new profile with no bookmarks.
export function bookmarksHtml(now = Date.now()) {
  const stamp = Math.floor(now / 1000);
  const rows = SITES.map(
    ({ name, url }) =>
      `        <DT><A HREF="${escape(url)}" ADD_DATE="${stamp}" LAST_MODIFIED="${stamp}">${escape(name)}</A>`
  ).join('\n');
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks Toolbar</H3>
    <DL><p>
${rows}
    </DL><p>
</DL><p>
`;
}
