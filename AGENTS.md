# AGENTS.md

## Verified commands
- Build workspace packages individually with npm workspaces, for example:
  - `npm run build -w @adunni/shared-types`
  - `npm run build -w @adunni/security`
  - `npm run build -w @adunni/orchestrator`
  - `npm run build -w @adunni/api-gateway`
- Run integration tests with:
  - `npm test -- --runInBand`

## Notes
- The root `npm run build` script currently fails because there is no `tsconfig.json` at the repository root.
- The integration tests resolve package imports from each package's `dist/` output.
