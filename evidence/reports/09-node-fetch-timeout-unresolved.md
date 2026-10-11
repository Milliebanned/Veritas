# Veritas report

**1 finding unresolved.**

Repository: `/Users/Apple/neatlog/bench/cases/09-node-fetch-timeout/repo` at `e9fa1c5ee5`

## Findings

| Package | Kind | Status | Priority | Affected files |
|---|---|---|---|---|
| node-fetch | breaking | Unresolved | 0.605 | src/client.js, src/status.js, test/status.test.js |

### node-fetch: breaking

node-fetch 3.3.2 is an ESM-only package, while the project uses CommonJS with require(). On Node.js v24, require() of an ESM-only package returns the module namespace object, causing the default export to be under .default. Since src/client.js calls fetch directly as a function (line 4), this will fail with "fetch is not a function". Affected: src/client.js, src/status.js, test/status.test.js. Reproduced: tests pass on 2.7.0 and fail on 3.3.2 (TypeError: fetch is not a function). Still failing after 3 attempts. Last diagnosis: The timeout error detection in src/status.js line 9 checks `err.code === 'ABORT_ERR'`, but node-fetch 3.3.2 does not use a `code` property for timeout errors. Instead, timeout errors are AbortError instances with `err.name === 'AbortError'` and `err.cause.name === 'AbortError'` (or similar cause chain). The check for `err.code === 'ABORT_ERR'` will never match, causing timeout errors to fall through to the 'down' classification. This is why test/status.test.js:21 fails with "Missing expected rejection" (the timeout error is not being thrown as expected) and test/status.test.js:34 expects 'timeout' but gets 'ok' (the timeout is not being detected, so the request appears to succeed).

Where:
- `src/client.js:1` in `getJson`
- `src/status.js:1`
- `test/status.test.js:4`

Sources read:
- registry: https://registry.npmjs.org/node-fetch
- release_notes: https://github.com/node-fetch/node-fetch/releases/tag/v3.0.0

## Repair: node-fetch 2.7.0 → 3.3.2

Outcome: **unresolved**. Still failing after 3 attempts. Last diagnosis: The timeout error detection in src/status.js line 9 checks `err.code === 'ABORT_ERR'`, but node-fetch 3.3.2 does not use a `code` property for timeout errors. Instead, timeout errors are AbortError instances with `err.name === 'AbortError'` and `err.cause.name === 'AbortError'` (or similar cause chain). The check for `err.code === 'ABORT_ERR'` will never match, causing timeout errors to fall through to the 'down' classification. This is why test/status.test.js:21 fails with "Missing expected rejection" (the timeout error is not being thrown as expected) and test/status.test.js:34 expects 'timeout' but gets 'ok' (the timeout is not being detected, so the request appears to succeed).

Branch: `veritas/node-fetch`

| Test run | Result | Passed | Failed |
|---|---|---|---|
| baseline | pass | 4 | 0 |
| after upgrade | fail | 2 | 2 |
| attempt 1 | fail | 2 | 2 |
| attempt 2 | fail | 2 | 2 |
| attempt 3 | fail | 2 | 2 |

### Attempt 1: tests failed

Fixed the import of node-fetch in src/client.js to handle the ESM-only package on Node.js v24. Since node-fetch 3.3.2 is ESM-only and the project uses CommonJS, require() returns the module namespace object. The default export is now accessed via destructuring with { default: fetch } to get the fetch function directly.

Diagnosis after the failure: The import fix in src/client.js (line 1) correctly resolved the ESM-only package issue, allowing fetch to be called as a function. However, node-fetch 3.3.2 changed the timeout error type from 'request-timeout' to 'AbortError'. In src/status.js (line 9), the code checks `err.type === 'request-timeout'` to distinguish timeouts from other errors, but this check now fails because timeout errors in node-fetch 3.3.2 are AbortError instances with `err.code === 'ABORT_ERR'` instead. This causes timeouts to be misclassified as 'down' rather than 'timeout', which is why test/status.test.js:34 expects 'timeout' but gets 'ok' (the request succeeds because it's not actually timing out as expected). Next: Update src/status.js line 9 to check for AbortError instead of the 'request-timeout' type. Change `err.type === 'request-timeout'` to `err.name === 'AbortError'` or `err.code === 'ABORT_ERR'` to properly detect timeout errors in node-fetch 3.3.2. This will correctly classify timeout errors as 'timeout' instead of 'down'.

```diff
diff --git a/src/client.js b/src/client.js
index 4a8cacb..36f58f1 100644
--- a/src/client.js
+++ b/src/client.js
@@ -1,4 +1,4 @@
-const fetch = require('node-fetch');
+const { default: fetch } = require('node-fetch');
 
 async function getJson(url, { timeoutMs = 2000 } = {}) {
   const res = await fetch(url, { timeout: timeoutMs, headers: { accept: 'application/json' } });
```

### Attempt 2: tests failed

Fixed the import of node-fetch in src/client.js to handle the ESM-only package on Node.js v24 by destructuring the default export. Updated src/status.js to check for AbortError instead of 'request-timeout' type, since node-fetch 3.3.2 changed timeout errors to use AbortError with name property instead of the old request-timeout type.

Diagnosis after the failure: The timeout error detection in src/status.js line 9 is checking `err.name === 'AbortError'`, but node-fetch 3.3.2 throws an AbortError with `err.code === 'ABORT_ERR'` for timeout errors. The check for `err.name === 'AbortError'` is too broad—it catches all AbortErrors, not just timeout-related ones. In node-fetch 3.3.2, timeout errors specifically have `err.code === 'ABORT_ERR'` to distinguish them from other abort reasons. The current check fails to properly identify timeout errors, causing them to fall through to the 'down' classification, which is why test/status.test.js:34 expects 'timeout' but gets 'ok' (the request succeeds because the timeout isn't being properly detected). Next: Update src/status.js line 9 to check for `err.code === 'ABORT_ERR'` instead of `err.name === 'AbortError'`. This will properly detect timeout errors in node-fetch 3.3.2, which throw AbortError instances with code 'ABORT_ERR' specifically for timeout conditions. Change the condition from `err.name === 'AbortError'` to `err.code === 'ABORT_ERR'` to correctly classify timeout errors as 'timeout' instead of 'down'.

```diff
diff --git a/src/client.js b/src/client.js
index 4a8cacb..36f58f1 100644
--- a/src/client.js
+++ b/src/client.js
@@ -1,4 +1,4 @@
-const fetch = require('node-fetch');
+const { default: fetch } = require('node-fetch');
 
 async function getJson(url, { timeoutMs = 2000 } = {}) {
   const res = await fetch(url, { timeout: timeoutMs, headers: { accept: 'application/json' } });
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

### Attempt 3: tests failed

Fixed the import of node-fetch in src/client.js to handle the ESM-only package on Node.js v24 by destructuring the default export with `const { default: fetch } = require('node-fetch')`. Updated src/status.js to check for `err.code === 'ABORT_ERR'` instead of `err.type === 'request-timeout'`, since node-fetch 3.3.2 changed timeout errors to throw AbortError instances with code 'ABORT_ERR' instead of the old request-timeout type.

Diagnosis after the failure: The timeout error detection in src/status.js line 9 checks `err.code === 'ABORT_ERR'`, but node-fetch 3.3.2 does not use a `code` property for timeout errors. Instead, timeout errors are AbortError instances with `err.name === 'AbortError'` and `err.cause.name === 'AbortError'` (or similar cause chain). The check for `err.code === 'ABORT_ERR'` will never match, causing timeout errors to fall through to the 'down' classification. This is why test/status.test.js:21 fails with "Missing expected rejection" (the timeout error is not being thrown as expected) and test/status.test.js:34 expects 'timeout' but gets 'ok' (the timeout is not being detected, so the request appears to succeed). Next: Update src/status.js line 9 to check for `err.name === 'AbortError'` instead of `err.code === 'ABORT_ERR'`. Node-fetch 3.3.2 throws AbortError instances for timeout conditions, and the error name property is the correct way to identify them. Change the condition from `err.code === 'ABORT_ERR'` to `err.name === 'AbortError'` to properly detect and classify timeout errors as 'timeout' instead of 'down'.

```diff
diff --git a/src/client.js b/src/client.js
index 4a8cacb..36f58f1 100644
--- a/src/client.js
+++ b/src/client.js
@@ -1,4 +1,4 @@
-const fetch = require('node-fetch');
+const { default: fetch } = require('node-fetch');
 
 async function getJson(url, { timeoutMs = 2000 } = {}) {
   const res = await fetch(url, { timeout: timeoutMs, headers: { accept: 'application/json' } });
diff --git a/src/status.js b/src/status.js
index 9d4b2ce..7328dea 100644
--- a/src/status.js
+++ b/src/status.js
@@ -6,7 +6,7 @@ async function checkStatus(baseUrl, { timeoutMs = 500 } = {}) {
     const body = await getJson(`${baseUrl}/status`, { timeoutMs });
     return body.state;
   } catch (err) {
-    return err.type === 'request-timeout' ? 'timeout' : 'down';
+    return err.code === 'ABORT_ERR' ? 'timeout' : 'down';
   }
 }
```

## Remaining risk

- node-fetch: no working fix was found. Still failing after 3 attempts. Last diagnosis: The timeout error detection in src/status.js line 9 checks `err.code === 'ABORT_ERR'`, but node-fetch 3.3.2 does not use a `code` property for timeout errors. Instead, timeout errors are AbortError instances with `err.name === 'AbortError'` and `err.cause.name === 'AbortError'` (or similar cause chain). The check for `err.code === 'ABORT_ERR'` will never match, causing timeout errors to fall through to the 'down' classification. This is why test/status.test.js:21 fails with "Missing expected rejection" (the timeout error is not being thrown as expected) and test/status.test.js:34 expects 'timeout' but gets 'ok' (the timeout is not being detected, so the request appears to succeed).

## Run

26 steps, 65 model calls, 348653 tokens, $0.4087.

