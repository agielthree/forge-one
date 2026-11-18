# forge-one

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/agielthree/forge-one/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/agielthree/forge-one/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A GitHub-compatible git forge in one process: git smart HTTP (upload-pack
protocol v2, receive-pack v0), REST v3, GraphQL and MCP from a single
in-memory store. Node 22, standard library only — no dependencies, no git
binary, no external services.

## Run

```sh
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

With `MAKEFUN_ENV_URL` set, the process binds an ephemeral port, registers
it with the env and exits when the env says done. Without it, it serves
standalone on `$PORT` (or an ephemeral port) until killed, so the kit's
local suite can dial it directly.

## Layout

- `main.ts` — entrypoint and the entry <-> env lifecycle.
- `src/app.ts` — the HTTP server: routing, auth, request ids.
- `src/git-http.ts` — smart-HTTP advertisements, ls-refs, fetch, receive-pack.
- `src/git.ts` — git objects, packfiles, reachability.
- `src/store.ts` — repositories, issues, pull requests, trees, merges.
- `src/rest.ts` — the REST v3 API.
- `src/graphql.ts` — the GraphQL API (parser + executor).
- `src/mcp.ts` — the MCP endpoint (2026-07-28 `server/discover`).

## Notes

- One bearer token (`MAKEFUN_SHOP_TOKEN`) names the viewer `adaiversen`;
  repositories under any other owner answer 404, never 403.
- All timestamps are frozen constants, so two runs of the same trial export
  byte-identical state.
- Packfiles carry plain objects (no deltas); fetch honours haves, depth and
  shallow boundaries, including deepen past a shallow boundary.
- Squash merges are three-way merges over the pull request's recorded base
  and head; a conflict answers 405.
