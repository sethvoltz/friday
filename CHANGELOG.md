# Changelog

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
