// The Model Context Protocol endpoint: POST /mcp, JSON-RPC 2.0, Streamable HTTP
// (plain JSON answers). Modern era 2026-07-28 via `server/discover`, with the
// legacy `initialize` handshake as a fallback. Tools mirror github-mcp-server.

import { VIEWER_LOGIN, Forge } from './store.ts';
import { FROZEN_ISO } from './util.ts';

export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const MCP_SERVER_NAME = 'forge-one';
export const MCP_SERVER_VERSION = '1.0.0';

export interface McpReply {
  status: number;
  body: unknown;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

function serverInfo(): Record<string, unknown> {
  return { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function repoJson(forge: Forge, owner: string, name: string): Record<string, unknown> | null {
  const repo = forge.getRepo(owner, name);
  if (!repo) return null;
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FROZEN_ISO,
    updated_at: FROZEN_ISO,
  };
}

function issueJson(forge: Forge, repoOwner: string, repoName: string, issue: { id: number; number: number; title: string; body: string; state: string; labels: Array<{ name: string; color: string }> }): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: VIEWER_LOGIN, type: 'User' },
    created_at: FROZEN_ISO,
    updated_at: FROZEN_ISO,
    html_url: `https://github.com/${repoOwner}/${repoName}/issues/${issue.number}`,
  };
}

function callTool(
  forge: Forge,
  name: string,
  args: Record<string, unknown>,
): { payload: unknown; isError: boolean } {
  const missing = (field: string): { payload: unknown; isError: boolean } => ({
    payload: { error: `Missing required argument: ${field}` },
    isError: true,
  });
  switch (name) {
    case 'create_repo': {
      const repoName = args.name as string | undefined;
      if (!repoName) return missing('name');
      const description = typeof args.description === 'string' ? args.description : '';
      const isPrivate = args.private === true;
      if (forge.getRepo(VIEWER_LOGIN, repoName)) {
        return { payload: { error: `Repository ${VIEWER_LOGIN}/${repoName} already exists` }, isError: true };
      }
      forge.createRepo(VIEWER_LOGIN, repoName, isPrivate, description);
      const payload = repoJson(forge, VIEWER_LOGIN, repoName);
      return { payload, isError: false };
    }
    case 'get_repo': {
      const owner = args.owner as string | undefined;
      const repoName = args.repo as string | undefined;
      if (!owner) return missing('owner');
      if (!repoName) return missing('repo');
      const payload = repoJson(forge, owner, repoName);
      if (!payload) return { payload: { error: `Repository ${owner}/${repoName} not found` }, isError: true };
      return { payload, isError: false };
    }
    case 'create_issue': {
      const owner = args.owner as string | undefined;
      const repoName = args.repo as string | undefined;
      const title = args.title as string | undefined;
      if (!owner) return missing('owner');
      if (!repoName) return missing('repo');
      if (!title) return missing('title');
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return { payload: { error: `Repository ${owner}/${repoName} not found` }, isError: true };
      const issue = forge.createIssue(repo, title, typeof args.body === 'string' ? args.body : '', []);
      return { payload: issueJson(forge, owner, repoName, issue), isError: false };
    }
    case 'list_issues': {
      const owner = args.owner as string | undefined;
      const repoName = args.repo as string | undefined;
      if (!owner) return missing('owner');
      if (!repoName) return missing('repo');
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return { payload: { error: `Repository ${owner}/${repoName} not found` }, isError: true };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = state === 'all' ? repo.issues : repo.issues.filter((issue) => issue.state === state);
      const payload = { issues: issues.map((issue) => issueJson(forge, owner, repoName, issue)) };
      return { payload, isError: false };
    }
    case 'create_pull_request': {
      const owner = args.owner as string | undefined;
      const repoName = args.repo as string | undefined;
      const title = args.title as string | undefined;
      const head = args.head as string | undefined;
      const base = args.base as string | undefined;
      if (!owner) return missing('owner');
      if (!repoName) return missing('repo');
      if (!title) return missing('title');
      if (!head) return missing('head');
      if (!base) return missing('base');
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return { payload: { error: `Repository ${owner}/${repoName} not found` }, isError: true };
      if (!repo.refs.has(`refs/heads/${head}`)) return { payload: { error: `Head branch "${head}" does not exist` }, isError: true };
      if (!repo.refs.has(`refs/heads/${base}`)) return { payload: { error: `Base branch "${base}" does not exist` }, isError: true };
      const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (duplicate) return { payload: { error: 'A pull request already exists for these branches' }, isError: true };
      const pull = forge.createPull(repo, title, typeof args.body === 'string' ? args.body : '', head, base);
      if (!pull) return { payload: { error: 'Could not create the pull request' }, isError: true };
      const payload = {
        id: pull.id,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        merged: pull.merged,
        head: { ref: pull.headRef, sha: pull.headSha },
        base: { ref: pull.baseRef, sha: pull.baseSha },
        html_url: `https://github.com/${owner}/${repoName}/pull/${pull.number}`,
      };
      return { payload, isError: false };
    }
    case 'merge_pull_request': {
      const owner = args.owner as string | undefined;
      const repoName = args.repo as string | undefined;
      const pullNumber = args.pull_number as number | undefined;
      if (!owner) return missing('owner');
      if (!repoName) return missing('repo');
      if (typeof pullNumber !== 'number') return missing('pull_number');
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return { payload: { error: `Repository ${owner}/${repoName} not found` }, isError: true };
      const pull = repo.pulls.find((candidate) => candidate.number === pullNumber);
      if (!pull) return { payload: { error: `Pull request #${pullNumber} not found` }, isError: true };
      if (pull.state !== 'open') return { payload: { error: 'Pull request is not open' }, isError: true };
      const merged = forge.mergePull(repo, pull);
      if (merged === 'conflict' || !merged) return { payload: { error: 'Merge conflict: the pull request cannot be merged' }, isError: true };
      return { payload: { merged: true, sha: merged.sha, number: pull.number, state: pull.state }, isError: false };
    }
    default:
      return { payload: { error: `Unknown tool: ${name}` }, isError: true };
  }
}

export function handleMcp(forge: Forge, body: unknown, headers: Record<string, string | undefined>): McpReply {
  const record = (body ?? {}) as Record<string, unknown>;
  const id = record.id ?? null;
  const method = typeof record.method === 'string' ? record.method : '';
  const params = (record.params ?? {}) as Record<string, unknown>;

  // A revision the server does not support is a -32022 with the supported list.
  const headerVersion = headers['mcp-protocol-version'];
  if (headerVersion !== undefined && headerVersion !== '' && !MCP_SUPPORTED_VERSIONS.includes(headerVersion)) {
    return { status: 200, body: rpcError(id, -32022, `Unsupported protocol version: ${headerVersion}`, { supported: MCP_SUPPORTED_VERSIONS }) };
  }

  if (method === 'server/discover') {
    const result = {
      supportedVersions: MCP_SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: serverInfo(),
      protocolVersion: '2026-07-28',
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
    };
    return { status: 200, body: rpcResult(id, result) };
  }

  if (method === 'initialize') {
    const requested = typeof (params as Record<string, unknown>).protocolVersion === 'string' ? (params as Record<string, unknown>).protocolVersion as string : '';
    const negotiated = MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    const result = {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: serverInfo(),
    };
    return { status: 200, body: rpcResult(id, result) };
  }

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    // A notification has no response body.
    return { status: 200, body: null };
  }

  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const tool = TOOLS.find((candidate) => candidate.name === toolName);
    if (!tool) {
      return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${toolName}`) };
    }
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const required = ((tool.inputSchema.required ?? []) as string[]).filter((field) => args[field] === undefined);
    if (required.length > 0) {
      const result = {
        content: [{ type: 'text', text: JSON.stringify({ error: `Missing required argument: ${required[0]}` }) }],
        structuredContent: { error: `Missing required argument: ${required[0]}` },
        isError: true,
      };
      return { status: 200, body: rpcResult(id, result) };
    }
    const outcome = callTool(forge, toolName, args);
    const result = {
      content: [{ type: 'text', text: JSON.stringify(outcome.payload) }],
      structuredContent: outcome.payload,
      ...(outcome.isError ? { isError: true } : {}),
    };
    return { status: 200, body: rpcResult(id, result) };
  }

  if (method === 'ping') {
    return { status: 200, body: rpcResult(id, {}) };
  }

  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}
