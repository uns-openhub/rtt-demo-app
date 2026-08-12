# Repository guide

- Use Node.js 22 or newer and pnpm.
- Keep the three neutral runtime profiles committed:
  `config-development-host.json`, `config-development-podman.json`, and
  `config-production.json`. Keep local credentials in environment variables and
  the selected local `config.json` untracked.
- `pnpm run verify` performs the repository build used by CI.
- Regenerate configuration types with `pnpm run generate-config-schema`.
- Regenerate checked-in UNS reference types with the `generate-uns-*` scripts.
- Do not add Azure Pipelines or deployment-version bump automation. GitHub
  Actions validates source changes; release tags are maintained separately.
