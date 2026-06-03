# Claude Code project context

The canonical guide for AI agents in this repo lives in `AGENTS.md`.
Claude Code automatically imports the line below — you do **not** need
to read the file twice.

@AGENTS.md

---

## Claude-Code-specific notes

These are conventions that only apply when working through Claude Code
(`claude` CLI / IDE integration). For shared rules (architecture,
commands, conventions) see the imported `AGENTS.md` above.

- **Service restarts** count as a destructive action; ask the user
  before running `D:\POS_V2\deploy\services\pos-v2-*.exe restart` or
  `restart-services.bat`, except when the user explicitly asked you to
  apply a change "and restart".
- **`customer-web` rebuilds** before web service restart: run
  `npm run build` in `customer-web/`, then restart `pos-v2-web`. The
  web service runs `next start`, not `next dev`, so source edits
  alone won't take effect.
- **Migrations**: prefer `node backend/scripts/migrate.js` over hand-
  rolled SQL. The script tracks applied files in `_migrations`. Never
  edit a migration that has already been applied — add a new one.
- **Parse-checking JSX**: there is no `@babel/parser` available locally,
  but Next's SWC works:

  ```js
  const swc = require('next/dist/build/swc');
  await swc.transform(src, {
    jsc: { parser: { syntax: 'ecmascript', jsx: true } }
  });
  ```

- **Thai UI**: the live UI is Thai. When you write user-visible strings
  (toasts, button labels, error messages), use Thai to match. Keep
  identifiers, comments, log messages, and commit messages in English.
- **One big file by design**: `customer-web/src/app/admin/page.jsx` is
  intentionally a single ~3k-line file with sub-tabs. Don't split it
  into smaller files without a strong reason — the user is used to
  navigating it as-is.
- **Skills available**: the user has `/code-review`, `/verify`, `/run`,
  `/loop`, `/schedule`, etc. installed. Suggest them when relevant
  instead of duplicating their behavior.
