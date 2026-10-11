# Veritas report

**1 verified fix ready for review (node-fetch).**

Repository: `/Users/Apple/neatlog/bench/cases/09-node-fetch-timeout/repo` at `17b657077d`

## Findings

| Package | Kind | Status | Priority | Affected files |
|---|---|---|---|---|
| node-fetch | breaking | Confirmed | 0.725 | src/client.js, src/status.js, test/status.test.js |

### node-fetch: breaking

The upgrade from node-fetch 2.7.0 to 3.3.2 introduces breaking changes that will cause the project to fail. The primary issues are: (1) node-fetch 3.x is ESM-only and cannot be loaded with require() in CommonJS projects on Node.js v24, and (2) the timeout option has been removed from the fetch API. The project uses both of these features in src/client.js. Affected: src/client.js, src/status.js, test/status.test.js. Reproduced: tests pass on 2.7.0 and fail on 3.3.2 (TypeError: fetch is not a function). Verified: tests pass on node-fetch 3.3.2 with a code change (attempt 1).

Where:
- `src/client.js:1` in `getJson`
- `src/client.js:4` in `getJson`
- `src/status.js:6`
- `test/status.test.js:4`
- `test/status.test.js:24`
- `test/status.test.js:34`

Sources read:
- registry: https://registry.npmjs.org/node-fetch
- release_notes: https://github.com/node-fetch/node-fetch/releases/tag/v3.0.0
- migration_guide: https://github.com/node-fetch/node-fetch/blob/HEAD/docs/v3-UPGRADE-GUIDE.md

## Repair: node-fetch 2.7.0 → 3.3.2

Outcome: **verified**. Verified on 3.3.2, branch veritas/node-fetch.

Branch: `veritas/node-fetch`

| Test run | Result | Passed | Failed |
|---|---|---|---|
| baseline | pass | 4 | 0 |
| after upgrade | fail | 2 | 2 |
| attempt 1 | pass | 4 | 0 |

Verification:
- Passed: Tests passed before the upgrade.
- Passed: Tests failed after the upgrade and before the fix.
- Passed: Tests pass with the fix.
- Passed: As many tests pass now (4) as before the upgrade (4).
- Passed: entire graph verify: VERDICT: NO EFFECT — the target tests behave exactly as before your edit.

### Attempt 1: tests passed

Fixed the project to work with node-fetch 3.3.2 by: (1) replacing require('node-fetch') with dynamic import() in src/client.js to handle ESM-only module in CommonJS, (2) replacing the removed timeout option with AbortSignal and AbortController for timeout handling, and (3) updating src/status.js to check for AbortError instead of the removed 'request-timeout' error type.

```diff
diff --git a/src/client.js b/src/client.js
index 4a8cacb..17da93f 100644
--- a/src/client.js
+++ b/src/client.js
@@ -1,9 +1,14 @@
-const fetch = require('node-fetch');
-
 async function getJson(url, { timeoutMs = 2000 } = {}) {
-  const res = await fetch(url, { timeout: timeoutMs, headers: { accept: 'application/json' } });
-  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
-  return res.json();
+  const { default: fetch } = await import('node-fetch');
+  const controller = new AbortController();
+  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
+  try {
+    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
+    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
+    return res.json();
+  } finally {
+    clearTimeout(timeoutId);
+  }
 }
 
 module.exports = { getJson };
diff --git a/src/status.js b/src/status.js
index 9d4b2ce..692549c 100644
--- a/src/status.js
+++ b/src/status.js
@@ -6,7 +6,7 @@ async function checkStatus(baseUrl, { timeoutMs = 500 } = {}) {
     const body = await getJson(`${baseUrl}/status`, { timeoutMs });
     return body.state;
   } catch (err) {
-    return err.type === 'request-timeout' ? 'timeout' : 'down';
+    return err.name === 'AbortError' ? 'timeout' : 'down';
   }
 }
```

Functions changed: getJson (src/client.js), checkStatus (src/status.js)

## Remaining risk

- node-fetch: verified by the project's own tests only. Behaviour the tests do not cover was not checked.

## Run

20 steps, 22 model calls, 148989 tokens, $0.176.

