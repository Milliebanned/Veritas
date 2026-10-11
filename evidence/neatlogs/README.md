
## Incident 1: raised, investigated and resolved (2026-10-11)

neatlogs raised this incident on its own after a spike in the "Execution Failed" detection group
(6 detections against a baseline of 0.3). It investigated 6 traces and named the cause: the repair
model submitted an answer without editing any file.

| Step | Evidence |
| --- | --- |
| Raised and investigated by neatlogs | `incident-1-list.png`, `incident-1-investigation.png` |
| Handed to the coding agent | `incident-1-sent-to-claude-code.png` |
| Fix applied (repair prompt v2, clearer refusal) | commit `cd0233f`, `../bench/incident1-after.json` |
| Marked resolved | `incident-1-resolved-list.png`, `incident-1-resolved.png` |
