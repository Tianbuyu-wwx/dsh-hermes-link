---
'@tianbuyu-wwx/dsh-hermes-link': patch
---

v0.3.6: fix dispatch_task continuable HTTP 500 (sseBroker not destructured)

### Fixed
- http/dispatch-task.mjs now destructures sseBroker from deps, preventing 'sseBroker is not defined' after a continuable child is spawned. Previously Hermes could receive HTTP 500 while the sub-agent actually ran.
