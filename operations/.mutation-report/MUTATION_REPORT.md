# Mutation Test Results

> Total mutants executed: 500
> Killed: 0 | Survived: 500 | Compile Error: 0
> **Mutation Score: 0.00%**

## Package Scores

| Package | Gen | Killed | Survived | Comp.Err | Score |
|---------|-----|--------|----------|----------|-------|
| 🔴 audit | 78 | 0 | 78 | 0 | **0.0%** |
| 🔴 autoscaler | 120 | 0 | 120 | 0 | **0.0%** |
| 🔴 autotuner | 30 | 0 | 30 | 0 | **0.0%** |
| 🔴 backup | 76 | 0 | 76 | 0 | **0.0%** |
| 🔴 chaosengine | 39 | 0 | 39 | 0 | **0.0%** |
| 🔴 circuitbreaker | 12 | 0 | 12 | 0 | **0.0%** |
| 🔴 configwatcher | 84 | 0 | 84 | 0 | **0.0%** |
| 🔴 federation | 61 | 0 | 61 | 0 | **0.0%** |

## Survivors (Test Gaps)

| ID | Package | Operator | Line | Original |
|----|---------|----------|------|----------|
| MUT_8e01b8 | audit | Arithmetic | 63 | `*` |
| MUT_8e01b8 | audit | Arithmetic | 63 | `*` |
| MUT_bb45ef | audit | Arithmetic | 64 | `*` |
| MUT_bb45ef | audit | Arithmetic | 64 | `*` |
| MUT_bb45ef | audit | Arithmetic | 64 | `*` |
| MUT_be47b1 | audit | Boolean | 97 | `true` |
| MUT_020a83 | audit | Arithmetic | 130 | `+` |
| MUT_de2f48 | audit | Logical | 144 | `>` |
| MUT_23246c | audit | Logical | 157 | `>=` |
| MUT_16a6c4 | audit | Boolean | 157 | `true` |
| MUT_56c73d | autoscaler | Logical | 60 | `!==` |
| MUT_547299 | autoscaler | Logical | 68 | `||` |
| MUT_547299 | autoscaler | Logical | 68 | `>` |
| MUT_547299 | autoscaler | Logical | 68 | `>=` |
| MUT_abe00f | autoscaler | Logical | 69 | `<` |
| MUT_432c1f | autoscaler | Logical | 70 | `>=` |
| MUT_7728c9 | autoscaler | Logical | 73 | `>` |
| MUT_a37fe6 | autoscaler | Logical | 74 | `>=` |
| MUT_75d64d | autoscaler | Logical | 76 | `||` |
| MUT_75d64d | autoscaler | Arithmetic | 76 | `*` |
| MUT_d42187 | autotuner | Logical | 86 | `===` |
| MUT_531afe | autotuner | Arithmetic | 90 | `+` |
| MUT_531afe | autotuner | Arithmetic | 90 | `*` |
| MUT_531afe | autotuner | Arithmetic | 90 | `*` |
| MUT_531afe | autotuner | Arithmetic | 90 | `-` |
| MUT_e37733 | autotuner | Arithmetic | 91 | `+` |
| MUT_e37733 | autotuner | Arithmetic | 91 | `*` |
| MUT_e37733 | autotuner | Arithmetic | 91 | `*` |
| MUT_e37733 | autotuner | Arithmetic | 91 | `-` |
| MUT_b6f026 | autotuner | Arithmetic | 92 | `+` |
| MUT_736f93 | backup | Arithmetic | 63 | `-` |
| MUT_605b4f | backup | Arithmetic | 65 | `*` |
| MUT_1e791a | backup | Arithmetic | 66 | `/` |
| MUT_cb592f | backup | Boolean | 68 | `true` |
| MUT_85297e | backup | Logical | 73 | `!==` |
| MUT_04c128 | backup | Boolean | 74 | `false` |
| MUT_70d9ea | backup | Arithmetic | 110 | `-` |
| MUT_ff55cf | backup | Boolean | 112 | `true` |
| MUT_181d43 | backup | Logical | 115 | `&&` |
| MUT_181d43 | backup | Logical | 115 | `!==` |
| MUT_bbba63 | chaosengine | Arithmetic | 48 | `+` |
| MUT_186362 | chaosengine | Arithmetic | 50 | `+` |
| MUT_5ebf3b | chaosengine | Arithmetic | 51 | `/` |
| MUT_7b47f6 | chaosengine | Arithmetic | 55 | `*` |
| MUT_ca468c | chaosengine | Arithmetic | 65 | `-` |
| MUT_ca468c | chaosengine | Logical | 65 | `>` |
| MUT_5bf399 | chaosengine | Arithmetic | 66 | `*` |
| MUT_5bf399 | chaosengine | Arithmetic | 66 | `+` |
| MUT_d053ac | chaosengine | Boolean | 86 | `false` |
| MUT_09110a | chaosengine | Boolean | 106 | `true` |
| MUT_efbcc5 | circuitbreaker | Logical | 25 | `&&` |
| MUT_9ba6c5 | circuitbreaker | Logical | 24 | `&&` |
| MUT_2670a0 | circuitbreaker | Logical | 23 | `===` |
| MUT_9ba6c5 | circuitbreaker | Logical | 24 | `>` |
| MUT_efbcc5 | circuitbreaker | Logical | 25 | `>=` |
| MUT_efbcc5 | circuitbreaker | Arithmetic | 25 | `-` |
| MUT_95cb2b | circuitbreaker | Logical | 36 | `===` |
| MUT_10bce6 | circuitbreaker | Logical | 43 | `===` |
| MUT_b65193 | circuitbreaker | Logical | 55 | `===` |
| MUT_b7055a | circuitbreaker | Logical | 58 | `===` |
| MUT_ebacce | configwatcher | Logical | 555 | `===` |
| MUT_10333f | configwatcher | Logical | 386 | `===` |
| MUT_af4490 | configwatcher | Negation | 224 | `!Array.isArray(oldVal)` |
| MUT_5d1f7f | configwatcher | Logical | 235 | `!==` |
| MUT_5269f2 | configwatcher | Logical | 222 | `===` |
| MUT_317922 | configwatcher | Logical | 178 | `===` |
| MUT_393f9a | configwatcher | Negation | 410 | `!(key in this.schema)` |
| MUT_45d350 | configwatcher | Logical | 230 | `>` |
| MUT_9c10f1 | configwatcher | Logical | 224 | `&&` |
| MUT_750312 | configwatcher | Logical | 182 | `===` |
| MUT_f4263f | federation | Boolean | 183 | `false` |
| MUT_061c13 | federation | Boolean | 525 | `false` |
| MUT_28d6f1 | federation | Logical | 299 | `===` |
| MUT_43ec4b | federation | Logical | 307 | `===` |
| MUT_af944a | federation | Boolean | 659 | `false` |
| MUT_461e10 | federation | Logical | 321 | `>` |
| MUT_f089c8 | federation | Logical | 417 | `||` |
| MUT_4a1199 | federation | Negation | 136 | `!r.success` |
| MUT_61c6aa | federation | Logical | 382 | `||` |
| MUT_639757 | federation | Arithmetic | 397 | `+` |