# Changelog

## [1.18.3](https://github.com/sethvoltz/friday/compare/v1.18.2...v1.18.3) (2026-06-10)


### Bug Fixes

* **dashboard:** revert kbHeight formula + pointerdown blur fix for Send/Stop ([#224](https://github.com/sethvoltz/friday/issues/224)) ([01c7265](https://github.com/sethvoltz/friday/commit/01c726549ee53b7760825168c9f120aff9fdcccb))

## [1.18.2](https://github.com/sethvoltz/friday/compare/v1.18.1...v1.18.2) (2026-06-10)


### Bug Fixes

* **dashboard:** four mobile polish bugs — composer jitter, header bounce, ThinkingBlock auto-scroll, textarea caret ([#222](https://github.com/sethvoltz/friday/issues/222)) ([2ee6676](https://github.com/sethvoltz/friday/commit/2ee66764d39f6b7f9218f5e628f4bc590ed2331c))

## [1.18.1](https://github.com/sethvoltz/friday/compare/v1.18.0...v1.18.1) (2026-06-10)


### Bug Fixes

* **dashboard:** StreamingBall overflow clip + iOS keyboard scroll-into-view ([#220](https://github.com/sethvoltz/friday/issues/220)) ([a3c314c](https://github.com/sethvoltz/friday/commit/a3c314c846572b430aa86e6a3c354cfa8d6d3e0b))

## [1.18.0](https://github.com/sethvoltz/friday/compare/v1.17.1...v1.18.0) (2026-06-09)


### Features

* **dashboard:** tiered cold-start Zero blocks hydration (FRI-161) ([#217](https://github.com/sethvoltz/friday/issues/217)) ([a86298f](https://github.com/sethvoltz/friday/commit/a86298f9ef6a91220fa6576914c57c50b01e0af0))

## [1.17.1](https://github.com/sethvoltz/friday/compare/v1.17.0...v1.17.1) (2026-06-09)


### Bug Fixes

* **dashboard:** FRI-162 sidebar sessions fetch — error state + bounded retry ([#215](https://github.com/sethvoltz/friday/issues/215)) ([49eb4b2](https://github.com/sethvoltz/friday/commit/49eb4b28aab34b64ee26d2c3822d2d0aa4cc7a9d))

## [1.17.0](https://github.com/sethvoltz/friday/compare/v1.16.0...v1.17.0) (2026-06-09)


### Features

* **dashboard:** FRI-160 chat scrolls the document, not a fixed overlay ([#213](https://github.com/sethvoltz/friday/issues/213)) ([b4afb68](https://github.com/sethvoltz/friday/commit/b4afb682ad2c0b4ce05a02d1e6d2012e08bc8c8f))

## [1.16.0](https://github.com/sethvoltz/friday/compare/v1.15.0...v1.16.0) (2026-06-09)


### Features

* **daemon,dashboard:** FRI-158 StreamingBall cursor + redacted-thinking + no-response fixes ([#209](https://github.com/sethvoltz/friday/issues/209)) ([3c4a323](https://github.com/sethvoltz/friday/commit/3c4a323398968763243fe6fe24b3738867f34131))

## [1.15.0](https://github.com/sethvoltz/friday/compare/v1.14.1...v1.15.0) (2026-06-09)


### Features

* **system:** durable, reconstructable compaction-in-progress indicator (FRI-159) ([#210](https://github.com/sethvoltz/friday/issues/210)) ([394359c](https://github.com/sethvoltz/friday/commit/394359cae161102c03dcf0be65588e5bbbc5f933))

## [1.14.1](https://github.com/sethvoltz/friday/compare/v1.14.0...v1.14.1) (2026-06-09)


### Bug Fixes

* **dashboard:** pin working agents to top of each sidebar bucket ([#206](https://github.com/sethvoltz/friday/issues/206)) ([daec740](https://github.com/sethvoltz/friday/commit/daec740ccfc667d8986d6b338e629b2c861c4c07))
* **dashboard:** reset chatWindowEnd on agent focus to fix scroll-back regression ([#208](https://github.com/sethvoltz/friday/issues/208)) ([c2c6cfb](https://github.com/sethvoltz/friday/commit/c2c6cfb51277873dda09a3f6c7cb9df0396edfef))

## [1.14.0](https://github.com/sethvoltz/friday/compare/v1.13.3...v1.14.0) (2026-06-09)


### Features

* **dashboard:** add planner agent icon ([#204](https://github.com/sethvoltz/friday/issues/204)) ([d9fe897](https://github.com/sethvoltz/friday/commit/d9fe8979aca03082b86ffffacc8c5739a3b81102))

## [1.13.3](https://github.com/sethvoltz/friday/compare/v1.13.2...v1.13.3) (2026-06-09)


### Bug Fixes

* **dashboard:** show friendly labels for sentinel prompts in ScheduleWakeupBlock ([#202](https://github.com/sethvoltz/friday/issues/202)) ([dbe52ed](https://github.com/sethvoltz/friday/commit/dbe52eda29e5934a537f741b6cdea04a957820d6))

## [1.13.2](https://github.com/sethvoltz/friday/compare/v1.13.1...v1.13.2) (2026-06-09)


### Bug Fixes

* **evolve:** suppress compact-boundary artefacts in transcript_user_retry scanner ([#200](https://github.com/sethvoltz/friday/issues/200)) ([57f2001](https://github.com/sethvoltz/friday/commit/57f20015721576ae49ceb1bccc0e7fc71d13a8c9))

## [1.13.1](https://github.com/sethvoltz/friday/compare/v1.13.0...v1.13.1) (2026-06-08)


### Bug Fixes

* **daemon:** raise nightly compaction sweep threshold to 100K ([#197](https://github.com/sethvoltz/friday/issues/197)) ([6560467](https://github.com/sethvoltz/friday/commit/6560467b9f68bdd08dd09de9d8a1f3cb70c69573))

## [1.13.0](https://github.com/sethvoltz/friday/compare/v1.12.0...v1.13.0) (2026-06-08)


### Features

* **dashboard:** purpose-built ScheduleWakeup tool renderer ([#194](https://github.com/sethvoltz/friday/issues/194)) ([fd1a7d1](https://github.com/sethvoltz/friday/commit/fd1a7d1d3fb44ac950112602ee3225ad84cc1953))

## [1.12.0](https://github.com/sethvoltz/friday/compare/v1.11.0...v1.12.0) (2026-06-08)


### Features

* **dashboard:** client staleness detection + version display ([#191](https://github.com/sethvoltz/friday/issues/191)) ([1ac110c](https://github.com/sethvoltz/friday/commit/1ac110cd6307bee772d671abc892681ab86850a0))


### Bug Fixes

* **dashboard:** prevent iOS Safari text-size inflation and input zoom ([#192](https://github.com/sethvoltz/friday/issues/192)) ([c1e4375](https://github.com/sethvoltz/friday/commit/c1e437584d90307446744845fed3a57406a0d994))

## [1.11.0](https://github.com/sethvoltz/friday/compare/v1.10.0...v1.11.0) (2026-06-08)


### Features

* **daemon:** add agent_unarchive ([#187](https://github.com/sethvoltz/friday/issues/187)) ([cfaad05](https://github.com/sethvoltz/friday/commit/cfaad05596f7096b575293b1ca283d8f8042de1b))
* **daemon:** app hot-reload stops live workers on reload ([#189](https://github.com/sethvoltz/friday/issues/189)) ([6a5cafb](https://github.com/sethvoltz/friday/commit/6a5cafbf883e7096b1cc7b90b0b117131f90849d))

## [1.10.0](https://github.com/sethvoltz/friday/compare/v1.9.0...v1.10.0) (2026-06-08)


### Features

* **dashboard:** mail explorer route — FTS, filters, deep-link (FRI-153) ([#186](https://github.com/sethvoltz/friday/issues/186)) ([6f6548b](https://github.com/sethvoltz/friday/commit/6f6548baf64434220383eaf97030939ff64e0519))

## [1.9.0](https://github.com/sethvoltz/friday/compare/v1.8.0...v1.9.0) (2026-06-06)


### Features

* **daemon:** include bare agents in nightly compaction sweep ([#184](https://github.com/sethvoltz/friday/issues/184)) ([098ae37](https://github.com/sethvoltz/friday/commit/098ae379fcea4c3610a9d003b0fdc799e968e16f))

## [1.8.0](https://github.com/sethvoltz/friday/compare/v1.7.0...v1.8.0) (2026-06-06)


### Features

* **system:** age-encrypted secrets vault (ADR-038) ([#182](https://github.com/sethvoltz/friday/issues/182)) ([44d2e17](https://github.com/sethvoltz/friday/commit/44d2e17bc4f4da0cb503e0b95b4909a0e82c1ff4))

## [1.7.0](https://github.com/sethvoltz/friday/compare/v1.6.0...v1.7.0) (2026-06-06)


### Features

* **system:** configurable models by role + planner agent type (FRI-16) ([#179](https://github.com/sethvoltz/friday/issues/179)) ([fbb2a9c](https://github.com/sethvoltz/friday/commit/fbb2a9c8c297565628959abc3520e09ce59d9b33))


### Bug Fixes

* **system:** harden CI-flaky zero-proxy, sync-harness, and worker tests ([#181](https://github.com/sethvoltz/friday/issues/181)) ([52e50d0](https://github.com/sethvoltz/friday/commit/52e50d01fa4b7d2f82ebb02bfc6f1ea26dee6db8))

## [1.6.0](https://github.com/sethvoltz/friday/compare/v1.5.0...v1.6.0) (2026-06-06)


### Features

* **system:** context-budget compaction policy, chat compaction UX, PreCompact memory flush (FRI-156, FRI-27) ([#177](https://github.com/sethvoltz/friday/issues/177)) ([fdb1dd2](https://github.com/sethvoltz/friday/commit/fdb1dd2613d07990b9fe56c477cfa720e687b026))

## [1.5.0](https://github.com/sethvoltz/friday/compare/v1.4.0...v1.5.0) (2026-06-05)


### Features

* **dashboard:** interactive AskUserQuestion panel renderer (FRI-152) ([#173](https://github.com/sethvoltz/friday/issues/173)) ([c8a4cb7](https://github.com/sethvoltz/friday/commit/c8a4cb7f8ee1cff1709a3037fce72aae15dbea9a))

## [1.4.0](https://github.com/sethvoltz/friday/compare/v1.3.0...v1.4.0) (2026-06-05)


### Features

* **daemon:** respawn worker after force-kill with unprocessed mail (FRI-154) ([#175](https://github.com/sethvoltz/friday/issues/175)) ([8daef1e](https://github.com/sethvoltz/friday/commit/8daef1e09ce70e1cf55d1548aa0e1c306ce6ca70))


### Bug Fixes

* **daemon:** reset watchdog bookkeeping on mail-driven idle→working wake ([#172](https://github.com/sethvoltz/friday/issues/172)) ([a5762b6](https://github.com/sethvoltz/friday/commit/a5762b61f8eb8b203910dc3ef332250ba1c9e1de))

## [1.3.0](https://github.com/sethvoltz/friday/compare/v1.2.2...v1.3.0) (2026-06-04)


### Features

* **system:** Intel (darwin-x64) release builds + richer `friday update` progress ([#168](https://github.com/sethvoltz/friday/issues/168)) ([5e9cb22](https://github.com/sethvoltz/friday/commit/5e9cb22ba7b53258825a1d53f0a647d0aa7f40e1))

## [1.2.2](https://github.com/sethvoltz/friday/compare/v1.2.1...v1.2.2) (2026-06-04)


### Bug Fixes

* **shared:** cast usage-stat token SUMs to float8 to avoid int4 overflow ([#166](https://github.com/sethvoltz/friday/issues/166)) ([9824bd5](https://github.com/sethvoltz/friday/commit/9824bd53bb11254cd3a67d715fa2153fb9e2e74d))

## [1.2.1](https://github.com/sethvoltz/friday/compare/v1.2.0...v1.2.1) (2026-06-04)


### Bug Fixes

* **daemon:** shell-env capture + execPath rewrite for MCP children (FRI-150) ([#162](https://github.com/sethvoltz/friday/issues/162)) ([f6b9d2e](https://github.com/sethvoltz/friday/commit/f6b9d2e5b8c128f11b03d561891fdf1409a94061))

## [1.2.0](https://github.com/sethvoltz/friday/compare/v1.1.2...v1.2.0) (2026-06-04)


### Features

* **cli:** render friday doctor sections live instead of all-at-once ([#163](https://github.com/sethvoltz/friday/issues/163)) ([e5cada8](https://github.com/sethvoltz/friday/commit/e5cada81a3858f2ac5ee1e7cefa452861437cf6f))

## [1.1.2](https://github.com/sethvoltz/friday/compare/v1.1.1...v1.1.2) (2026-06-04)


### Bug Fixes

* **cli:** exec-in-place launchd shim labeled "friday-supervisor" ([#159](https://github.com/sethvoltz/friday/issues/159)) ([85623ec](https://github.com/sethvoltz/friday/commit/85623ec9dfc6cef0abb67be9ef73c03f3785cb79))

## [1.1.1](https://github.com/sethvoltz/friday/compare/v1.1.0...v1.1.1) (2026-06-03)


### Bug Fixes

* **packaging:** relativize symlinks so the tarball relocates; drop claude-code from Brewfile ([#157](https://github.com/sethvoltz/friday/issues/157)) ([6259301](https://github.com/sethvoltz/friday/commit/6259301cf73c29ff53ce1ca207dc3eab57e16cb9))

## [1.1.0](https://github.com/sethvoltz/friday/compare/v1.0.0...v1.1.0) (2026-06-03)


### Features

* **system:** evolve auto-escalates critical+high code proposals to a builder that drives a review-ready green PR (FRI-149) ([#153](https://github.com/sethvoltz/friday/issues/153)) ([4a838ce](https://github.com/sethvoltz/friday/commit/4a838ce44d3e519afa0f074506d0592951a88dcd))

## 1.0.0 (2026-06-02)


### Features

* **daemon:** block-stream FSM deepening (FRI-148) ([#152](https://github.com/sethvoltz/friday/issues/152)) ([bdd8360](https://github.com/sethvoltz/friday/commit/bdd8360e1b2a7056abbcecf19ccbc851f479f1fb))
* **system:** replace brew distribution with curl install + friday update + release-please CI ([#148](https://github.com/sethvoltz/friday/issues/148)) ([7f48e4d](https://github.com/sethvoltz/friday/commit/7f48e4d7a12f19dbdd5cdb0b3492d7749d2c35ad))
* **system:** user-facing scheduled reminders that fire as a chat notification without spawning an agent (FRI-143) ([#149](https://github.com/sethvoltz/friday/issues/149)) ([d51174a](https://github.com/sethvoltz/friday/commit/d51174a453d65d08d81a421f240bd7cedbc61674))
