# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: matrix-disposable-live.spec.ts >> disposable accounts pair, verify, exchange encrypted history, and reject invalid access
- Location: tests\e2e\matrix-disposable-live.spec.ts:51:1

# Error details

```
Error: page.evaluate: Error: The server-side retention request failed (HTTP 404).
    at $ (http://127.0.0.1:5174/assets/matrix-harness-D_KVH38N.js:20:58551)
    at async Z (http://127.0.0.1:5174/assets/matrix-harness-D_KVH38N.js:20:59701)
    at async Object.send (http://127.0.0.1:5174/assets/matrix-harness-D_KVH38N.js:20:63639)
    at async <anonymous>:396:30
```