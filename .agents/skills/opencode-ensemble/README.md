# OpenCode Ensemble Skill

Guidance for using OpenCode Ensemble to coordinate multiple AI coding agents safely and effectively.

Install from this repository:

```bash
npx skills@latest add hueyexe/opencode-ensemble --skill opencode-ensemble
```

Use this skill when you want your agent to decide whether a team is worthwhile, split work into independent slices, choose `explore` vs `build` teammates, select model strategy, write teammate prompts, review results, and clean up safely.

## Structure

```text
opencode-ensemble/
├── SKILL.md
└── references/
    ├── coordination-patterns.md
    ├── prompt-recipes.md
    ├── lead-checklists.md
    ├── anti-patterns.md
    └── eval-scenarios.md
```

`SKILL.md` is the short operational guide. Reference files provide deeper patterns, prompt recipes, checklists, anti-patterns, and pressure scenarios.
