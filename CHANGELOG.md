# Changelog

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
