# hidden-spec-cli-mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/gp897318-beep/hidden-spec-cli-mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/gp897318-beep/hidden-spec-cli-mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend — one patch tool for every AI edit format. `main.ts` (Node 22, standard library only) applies AI-written edits to a tree of text files in four formats — unified diff, SEARCH/REPLACE, V4A, and JSON — all-or-nothing, with three-tier line matching (exact, trailing-whitespace-insensitive, indentation-insensitive). `SPEC.md` is the whole specification.

## Run it

```sh
node main.ts [PATCH]
```

`PATCH` is a patch file (or `-` / omitted for stdin). `--format=auto|unified|search-replace|v4a|json`, `--check` for a dry run, `--strict` for exact (tier 0) matching only. See `SPEC.md` for the full contract. Practice set: `node check.ts ../program/generator/practice.json` scores 100/100.

---

<sub>Entered on [make.fun](https://make.fun/?ref=kd40mnmt&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
