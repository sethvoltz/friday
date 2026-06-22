# Changelog

## [1.32.0](https://github.com/sethvoltz/friday/compare/v1.31.1...v1.32.0) (2026-06-22)


### Features

* **dashboard:** redesign Memories page — RailShell, faceted filter, infinite scroll, accordion (FRI-172) ([#312](https://github.com/sethvoltz/friday/issues/312)) ([20a6c82](https://github.com/sethvoltz/friday/commit/20a6c82e53794f464df3b411ab0c17bc078ced6b))

## [1.31.1](https://github.com/sethvoltz/friday/compare/v1.31.0...v1.31.1) (2026-06-22)


### Bug Fixes

* **dashboard:** reserve Inbox bell width in header priority+ overflow ([#310](https://github.com/sethvoltz/friday/issues/310)) ([20d11a2](https://github.com/sethvoltz/friday/commit/20d11a2207f5f69903958c8e9bef427c6e014d5b))

## [1.31.0](https://github.com/sethvoltz/friday/compare/v1.30.0...v1.31.0) (2026-06-22)


### Features

* **system:** stateless capture & intake routing (FRI-171, ADR-047) ([#308](https://github.com/sethvoltz/friday/issues/308)) ([8fe9412](https://github.com/sethvoltz/friday/commit/8fe9412bb6e9019b33d767d83578a26d46dde404))

## [1.30.0](https://github.com/sethvoltz/friday/compare/v1.29.1...v1.30.0) (2026-06-22)


### Features

* **evolve:** memory dreaming — nightly session→memory consolidation (FRI-26) ([#306](https://github.com/sethvoltz/friday/issues/306)) ([a8ea2ea](https://github.com/sethvoltz/friday/commit/a8ea2ea70edd5e800a83b680bbb50879b433278e))

## [1.29.1](https://github.com/sethvoltz/friday/compare/v1.29.0...v1.29.1) (2026-06-21)


### Bug Fixes

* **daemon:** allow builder writes to ~/.friday/repos for git worktree metadata ([#305](https://github.com/sethvoltz/friday/issues/305)) ([a41a3b6](https://github.com/sethvoltz/friday/commit/a41a3b6372e9cd3b952ddbf56d194bc973a4eb79))
* **evolve:** strip injected boilerplate before retry cosine comparison ([#303](https://github.com/sethvoltz/friday/issues/303)) ([b3554c0](https://github.com/sethvoltz/friday/commit/b3554c0ac78d228f54c8ad509c674c75905cc9d9))

## [1.29.0](https://github.com/sethvoltz/friday/compare/v1.28.1...v1.29.0) (2026-06-19)


### Features

* **evolve:** upgrade-aware proposal resolution + version in startup logs ([#300](https://github.com/sethvoltz/friday/issues/300)) ([fd62a90](https://github.com/sethvoltz/friday/commit/fd62a9029d0d0eea064e73cd439c4c00382c9fd9))

## [1.28.1](https://github.com/sethvoltz/friday/compare/v1.28.0...v1.28.1) (2026-06-19)


### Bug Fixes

* **system:** reconcile Zero publication on daemon boot so `friday update` completes upgrades (ADR-045) ([#298](https://github.com/sethvoltz/friday/issues/298)) ([22babd6](https://github.com/sethvoltz/friday/commit/22babd6c0a51ea06812318eb1f26684536cbe037))

## [1.28.0](https://github.com/sethvoltz/friday/compare/v1.27.0...v1.28.0) (2026-06-19)


### Features

* **cli:** dependency preflight gate + `friday provision`; update execs new binary's provisioner (ADR-044) ([#295](https://github.com/sethvoltz/friday/issues/295)) ([b30c98a](https://github.com/sethvoltz/friday/commit/b30c98a42790d7aebf81cd1ec87a37fcf9c67024))

## [1.27.0](https://github.com/sethvoltz/friday/compare/v1.26.0...v1.27.0) (2026-06-19)


### Features

* **system:** habits — core habit/streak tracker (FRI-169) ([#294](https://github.com/sethvoltz/friday/issues/294)) ([160246b](https://github.com/sethvoltz/friday/commit/160246bd3e46a84ae1e0cba8a9a1b823db8b141e))

## [1.26.0](https://github.com/sethvoltz/friday/compare/v1.25.0...v1.26.0) (2026-06-18)


### Features

* **memory:** add pgvector hybrid (FTS + semantic) recall to memory_entries (FRI-24) ([4a41043](https://github.com/sethvoltz/friday/commit/4a410436458ae9cc958c30c4160093086b818421))

## [1.25.0](https://github.com/sethvoltz/friday/compare/v1.24.2...v1.25.0) (2026-06-18)


### Features

* **system:** make reminders first-class (FRI-168) ([#289](https://github.com/sethvoltz/friday/issues/289)) ([6ae559e](https://github.com/sethvoltz/friday/commit/6ae559e1338f0e8c002c8d4e900176ed6e42c835))

## [1.24.2](https://github.com/sethvoltz/friday/compare/v1.24.1...v1.24.2) (2026-06-17)


### Bug Fixes

* **daemon:** move dynamic memory recall to per-turn body, not frozen systemPrompt.append (FRI-89) ([#287](https://github.com/sethvoltz/friday/issues/287)) ([1cf3e1f](https://github.com/sethvoltz/friday/commit/1cf3e1f0a0f8b36af8f3b1630e8fbdd48bd943f4))

## [1.24.1](https://github.com/sethvoltz/friday/compare/v1.24.0...v1.24.1) (2026-06-17)


### Bug Fixes

* **daemon:** inject fresh per-turn datetime on the dispatch body (FRI-167) ([#285](https://github.com/sethvoltz/friday/issues/285)) ([bc6bbd2](https://github.com/sethvoltz/friday/commit/bc6bbd29f34fda1267dc333dc6749bef7b230c08))

## [1.24.0](https://github.com/sethvoltz/friday/compare/v1.23.2...v1.24.0) (2026-06-15)


### Features

* **dashboard:** full-width chat scrollbar at the window edge + dev:zero launcher ([#282](https://github.com/sethvoltz/friday/issues/282)) ([5996b14](https://github.com/sethvoltz/friday/commit/5996b148bc60133272afd917a67fe82dfda3f00e))

## [1.23.2](https://github.com/sethvoltz/friday/compare/v1.23.1...v1.23.2) (2026-06-15)


### Bug Fixes

* **dashboard:** add touch-action pan-x pan-y to prevent iOS scroll hijack ([#280](https://github.com/sethvoltz/friday/issues/280)) ([46d52de](https://github.com/sethvoltz/friday/commit/46d52dec16bbf51e8b6ce4d323124a56051da40a))

## [1.23.1](https://github.com/sethvoltz/friday/compare/v1.23.0...v1.23.1) (2026-06-13)


### Bug Fixes

* **dashboard:** make URL route the authoritative chat send target (FRI-72) ([#276](https://github.com/sethvoltz/friday/issues/276)) ([0991d5a](https://github.com/sethvoltz/friday/commit/0991d5ab0d779732529d9ce27ed5ee21ac870c4f))

## [1.23.0](https://github.com/sethvoltz/friday/compare/v1.22.6...v1.23.0) (2026-06-13)


### Features

* **daemon:** bare-mirror workspaces for remote-only repos ([#271](https://github.com/sethvoltz/friday/issues/271)) ([2a93917](https://github.com/sethvoltz/friday/commit/2a9391717ecb79da0abfb7081bd0fb43e2991a87))
* **daemon:** pending-block reaper — backstop missed-NOTIFY silent loss ([#275](https://github.com/sethvoltz/friday/issues/275)) ([ea990ec](https://github.com/sethvoltz/friday/commit/ea990ec0afebc1785b76808315d6d7b42a77155b))
* **scheduler:** record schedule fires in schedule_runs + sync to dashboard ([#273](https://github.com/sethvoltz/friday/issues/273)) ([4b18f7d](https://github.com/sethvoltz/friday/commit/4b18f7dfe7ca6eda3bb88c952e167b7cd890c3f0))


### Bug Fixes

* **daemon:** estimate live context from per-request usage, not the cumulative turn row ([#272](https://github.com/sethvoltz/friday/issues/272)) ([d8683c4](https://github.com/sethvoltz/friday/commit/d8683c4e108e9679cba58f7c658278f08bd04468))
* **daemon:** never silently drop a user chat to a scheduled agent (SEV-0) ([#274](https://github.com/sethvoltz/friday/issues/274)) ([adbd5fc](https://github.com/sethvoltz/friday/commit/adbd5fc13fc7d5d72dd8e78ce9bfe1476a968b36))

## [1.22.6](https://github.com/sethvoltz/friday/compare/v1.22.5...v1.22.6) (2026-06-13)


### Bug Fixes

* **dashboard:** capture browser exceptions in PostHog ([#269](https://github.com/sethvoltz/friday/issues/269)) ([1b6e0b8](https://github.com/sethvoltz/friday/commit/1b6e0b80144b2d6c4fd61a25d6cc3e345179bc9d))

## [1.22.5](https://github.com/sethvoltz/friday/compare/v1.22.4...v1.22.5) (2026-06-12)


### Bug Fixes

* agents inherit the captured shell PATH (gh/brew tools) + doctor steers PATH to ~/.zshenv ([#266](https://github.com/sethvoltz/friday/issues/266)) ([70584d5](https://github.com/sethvoltz/friday/commit/70584d5a9eab45372143664494626e5f39bd26da))

## [1.22.4](https://github.com/sethvoltz/friday/compare/v1.22.3...v1.22.4) (2026-06-12)


### Bug Fixes

* **cli:** doctor row + update respects stopped/disabled state + friday disable/enable ([#264](https://github.com/sethvoltz/friday/issues/264)) ([07896b5](https://github.com/sethvoltz/friday/commit/07896b527db52643ea06756c014f2ce28c00cd27))

## [1.22.3](https://github.com/sethvoltz/friday/compare/v1.22.2...v1.22.3) (2026-06-12)


### Bug Fixes

* **cli:** capture + restore app-agent Claude sessions (shared agent-cwd resolver) ([#262](https://github.com/sethvoltz/friday/issues/262)) ([50acba5](https://github.com/sethvoltz/friday/commit/50acba57a777b7b705de6d3cb159e113c8f7c8d2))

## [1.22.2](https://github.com/sethvoltz/friday/compare/v1.22.1...v1.22.2) (2026-06-12)


### Bug Fixes

* **system:** build server-side PostHog lazily so its vault key resolves post-warm (FRI-166) ([#259](https://github.com/sethvoltz/friday/issues/259)) ([a2566bb](https://github.com/sethvoltz/friday/commit/a2566bb18b39820c0c0239a6161cf9fc04e5d5ed))
* **system:** surface Brewfile caveats + doctor checks node resolves in the worker shell ([#261](https://github.com/sethvoltz/friday/issues/261)) ([030c6ee](https://github.com/sethvoltz/friday/commit/030c6ee68880d3f029488a1d8e906d1a9e5437b0))

## [1.22.1](https://github.com/sethvoltz/friday/compare/v1.22.0...v1.22.1) (2026-06-12)


### Bug Fixes

* **cli:** warm the age vault once at CLI entry so vault secrets resolve (FRI-166) ([#257](https://github.com/sethvoltz/friday/issues/257)) ([fbb618d](https://github.com/sethvoltz/friday/commit/fbb618d395172de91583b4ee735093efaf26d1ed))

## [1.22.0](https://github.com/sethvoltz/friday/compare/v1.21.0...v1.22.0) (2026-06-11)


### Features

* **cli:** reconcile Cloudflare tunnel to serve-intent on start; restore stages dark (FRI-166) ([#255](https://github.com/sethvoltz/friday/issues/255)) ([004be9f](https://github.com/sethvoltz/friday/commit/004be9f92aa0793b9df1fb5c87fd8c395bd95b17))

## [1.21.0](https://github.com/sethvoltz/friday/compare/v1.20.4...v1.21.0) (2026-06-11)


### Features

* **cli:** `friday backup --full` + faithful full restore for machine migration ([#253](https://github.com/sethvoltz/friday/issues/253)) ([435b9df](https://github.com/sethvoltz/friday/commit/435b9df9f53f1f99bb2daa1b5b8b3f6dae973566))

## [1.20.4](https://github.com/sethvoltz/friday/compare/v1.20.3...v1.20.4) (2026-06-11)


### Bug Fixes

* **daemon:** seed the orchestrator agent on boot (fresh-install chat skeleton hang) ([#251](https://github.com/sethvoltz/friday/issues/251)) ([655e950](https://github.com/sethvoltz/friday/commit/655e95023acd2b22b1a84bd8841e493401d4e9da))

## [1.20.3](https://github.com/sethvoltz/friday/compare/v1.20.2...v1.20.3) (2026-06-11)


### Bug Fixes

* **cli:** friday setup auto-restarts Postgres on wal_level change + always inits the vault ([#249](https://github.com/sethvoltz/friday/issues/249)) ([1b1c34d](https://github.com/sethvoltz/friday/commit/1b1c34dd657146143fa9d3d1fc9ec81f38fe8e91))

## [1.20.2](https://github.com/sethvoltz/friday/compare/v1.20.1...v1.20.2) (2026-06-11)


### Bug Fixes

* defer daemon start to first-run setup; warn on age-key-less backups ([#247](https://github.com/sethvoltz/friday/issues/247)) ([1e34450](https://github.com/sethvoltz/friday/commit/1e34450b0887ee1a3dc52bdadbf08736f5973696))

## [1.20.1](https://github.com/sethvoltz/friday/compare/v1.20.0...v1.20.1) (2026-06-11)


### Bug Fixes

* **cli:** provision Postgres before migrating in `friday setup` ([#244](https://github.com/sethvoltz/friday/issues/244)) ([5cf1c85](https://github.com/sethvoltz/friday/commit/5cf1c85a446810ccf6c6381bc22651cafbbbf7ee))

## [1.20.0](https://github.com/sethvoltz/friday/compare/v1.19.2...v1.20.0) (2026-06-11)


### Features

* restore Intel x64 release publishing + installer robustness ([#240](https://github.com/sethvoltz/friday/issues/240)) ([e7a4fa9](https://github.com/sethvoltz/friday/commit/e7a4fa96a41e7a104d9c9477246769bf0c484bd6))

## [1.19.2](https://github.com/sethvoltz/friday/compare/v1.19.1...v1.19.2) (2026-06-10)


### Bug Fixes

* **dashboard:** chat-route inner-scroller — kills keyboard-up composer stutter (ADR-041) ([#237](https://github.com/sethvoltz/friday/issues/237)) ([4079448](https://github.com/sethvoltz/friday/commit/4079448a9a97f6bed77bbfb11a6a7afbccb8f5c9))

## [1.19.1](https://github.com/sethvoltz/friday/compare/v1.19.0...v1.19.1) (2026-06-10)


### Bug Fixes

* **dashboard:** rebuild soft-keyboard geometry on visual-viewport anchors (ADR-040) ([#235](https://github.com/sethvoltz/friday/issues/235)) ([db8e88f](https://github.com/sethvoltz/friday/commit/db8e88fb3146389591a75d7a92a7fef6708e7799))

## [1.19.0](https://github.com/sethvoltz/friday/compare/v1.18.6...v1.19.0) (2026-06-10)


### Features

* **cli:** TTY-aware columns + color for `secrets list` ([#233](https://github.com/sethvoltz/friday/issues/233)) ([bcd2beb](https://github.com/sethvoltz/friday/commit/bcd2beb066ed7b9953251d48475cf8473a4c36f7))


### Bug Fixes

* **system:** friday doctor reports vault secrets and config ports accurately ([#232](https://github.com/sethvoltz/friday/issues/232)) ([54c7529](https://github.com/sethvoltz/friday/commit/54c75298d4d5049a2b9d24230a24474f34fca106))

## [1.18.6](https://github.com/sethvoltz/friday/compare/v1.18.5...v1.18.6) (2026-06-10)


### Bug Fixes

* **dashboard:** replace vv.resize keyboard listener with focusin/focusout-only ([#230](https://github.com/sethvoltz/friday/issues/230)) ([0d4cb01](https://github.com/sethvoltz/friday/commit/0d4cb019e9055e0b1834058947757bbd02843689))

## [1.18.5](https://github.com/sethvoltz/friday/compare/v1.18.4...v1.18.5) (2026-06-10)


### Bug Fixes

* **dashboard:** fix mobile keyboard layout bugs ([#228](https://github.com/sethvoltz/friday/issues/228)) ([a162b9a](https://github.com/sethvoltz/friday/commit/a162b9ae2cde38a5f6c05972559db9a57560e129))

## [1.18.4](https://github.com/sethvoltz/friday/compare/v1.18.3...v1.18.4) (2026-06-10)


### Bug Fixes

* **daemon:** correct mail backstop tool-name check to use MCP-prefixed name ([#226](https://github.com/sethvoltz/friday/issues/226)) ([42401a1](https://github.com/sethvoltz/friday/commit/42401a1d5d46ba4ce4a6f94744e40251ad90d223))

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
