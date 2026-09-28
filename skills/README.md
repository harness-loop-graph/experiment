# Skills

Skills exposed to the harness through `harness-config.json`
(`--harness-config harness-config.json`). The same set applies to C1, C2 and C3.

| Skill | Source | License |
|---|---|---|
| `caveman` | [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) `skills/caveman/SKILL.md` at `2fd153c67988e980fb0b2455c90832159a6a5a25`, copied unmodified | MIT (`caveman/LICENSE`) |

The harness only puts each skill's `name` and `description` in the model's
context; the body is read when the model calls `load_skill`. `caveman`'s
description triggers on requests for brevity ("be brief", "less tokens",
`/caveman`), which the experiment task does not contain, so the model decides
on its own whether to load it. Check `load_skill` calls in the audit logs of
each run to know whether it was used.
