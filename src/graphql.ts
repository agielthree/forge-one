// A small GraphQL executor for the suite's documents: a tokenizer and recursive
// descent parser for the operation/field/argument subset GitHub's CLI sends,
// plus resolvers over the same store the REST surface uses. Unknown fields are
// reported as `Cannot query field "<name>" on type "<Type>".` with HTTP 200.

import { VIEWER_ID, VIEWER_LOGIN, Forge, type Issue, type Pull, type Repo } from './store.ts';
import { b64urlDecode, b64urlEncode, FROZEN_ISO } from './util.ts';

// -------------------------------------------------------------------------------------------
// tokenizer + parser
// -------------------------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():[]!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          const next = source[i + 1]!;
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j]!)) j += 1;
      const text = source.slice(i, j);
      if (text.includes('.') || text.includes('e') || text.includes('E')) tokens.push({ kind: 'float', value: Number(text) });
      else tokens.push({ kind: 'int', value: Number(text) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface Selection {
  kind: 'field' | 'fragment';
  alias?: string;
  name?: string;
  args?: Array<{ name: string; value: ValueNode }>;
  selections?: Selection[];
  typeCondition?: string;
}

export interface Operation {
  operation: 'query' | 'mutation';
  name?: string;
  variables: string[];
  selections: Selection[];
}

export interface FragmentDef {
  name: string;
  typeCondition: string;
  selections: Selection[];
}

class Parser {
  private pos = 0;
  private tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${JSON.stringify(token)}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${JSON.stringify(token)}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
    return token.value;
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, FragmentDef> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', variables: [], selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        const operation = token.value as 'query' | 'mutation';
        let name: string | undefined;
        const next = this.peek();
        if (next?.kind === 'name') name = this.next().value as string;
        const variables: string[] = [];
        if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
          this.next();
          while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ')')) {
            this.expectPunct('$');
            variables.push(this.expectName());
            this.expectPunct(':');
            this.parseType();
            if (this.peek()?.kind === 'punct' && this.peek()!.value === '=') {
              this.next();
              this.parseValue();
            }
          }
          this.expectPunct(')');
        }
        operations.push({ operation, name, variables, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        fragments.set(name, { name, typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(token)} in GraphQL document`);
    }
    return { operations, fragments };
  }

  private parseType(): void {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '!') this.next();
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()!.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek()!;
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next?.kind === 'name') {
        return { kind: 'fragment', name: this.next().value as string };
      }
      return { kind: 'fragment', selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.peek()?.kind === 'punct' && this.peek()!.value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    let selections: Selection[] | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => valueOf(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argsOf(selection: Selection, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of selection.args ?? []) out[arg.name] = valueOf(arg.value, variables);
  return out;
}

// -------------------------------------------------------------------------------------------
// schema field lists (for __type introspection)
// -------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'body', 'headRefOid', 'baseRefOid', 'createdAt', 'updatedAt', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt', 'description', 'isPrivate'],
  SearchType: [],
};

const SEARCH_TYPE_VALUES = ['DISCUSSION', 'ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER'];

// -------------------------------------------------------------------------------------------
// executor
// -------------------------------------------------------------------------------------------

type Tagged =
  | { type: 'Query'; forge: Forge }
  | { type: 'Mutation'; forge: Forge }
  | { type: 'User'; login: string; id: number }
  | { type: 'Repository'; forge: Forge; repo: Repo }
  | { type: 'Issue'; forge: Forge; repo: Repo; issue: Issue }
  | { type: 'PullRequest'; forge: Forge; repo: Repo; pull: Pull }
  | { type: 'IssueConnection'; forge: Forge; repo: Repo; issues: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { type: 'PullRequestConnection'; forge: Forge; repo: Repo; pulls: Pull[] }
  | { type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { type: 'BranchRef'; name: string }
  | { type: '__Type'; name: string }
  | { type: 'CreateIssuePayload'; forge: Forge; repo: Repo; issue: Issue }
  | { type: 'CloseIssuePayload'; forge: Forge; repo: Repo; issue: Issue }
  | { type: 'CreatePullRequestPayload'; forge: Forge; repo: Repo; pull: Pull }
  | { type: 'MergePullRequestPayload'; forge: Forge; repo: Repo; pull: Pull }
  | { type: 'AddCommentPayload'; forge: Forge; repo: Repo; issue: Issue; commentId: number; commentBody: string }
  | { type: 'CommentEdge'; forge: Forge; repo: Repo; issue: Issue; commentId: number; commentBody: string }
  | { type: 'IssueComment'; id: number; body: string };

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
  fragments: Map<string, FragmentDef>;
}

function fieldError(ctx: Ctx, type: string, name: string): void {
  ctx.errors.push({ message: `Cannot query field "${name}" on type "${type}".` });
}

function executeSelections(ctx: Ctx, tagged: Tagged, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.name !== undefined) {
        const def = ctx.fragments.get(selection.name);
        if (def && def.typeCondition === tagged.type) {
          Object.assign(out, executeSelections(ctx, tagged, def.selections));
        }
        continue;
      }
      if (selection.typeCondition !== undefined && selection.typeCondition !== tagged.type) continue;
      Object.assign(out, executeSelections(ctx, tagged, selection.selections ?? []));
      continue;
    }
    const key = selection.alias ?? selection.name!;
    const value = resolveField(ctx, tagged, selection);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function resolveField(ctx: Ctx, tagged: Tagged, selection: Selection): unknown {
  const name = selection.name!;
  const args = argsOf(selection, ctx.variables);
  const sub = selection.selections ?? [];
  switch (tagged.type) {
    case 'Query': {
      if (name === '__typename') return 'Query';
      if (name === 'viewer') {
        return sub.length > 0 ? executeSelections(ctx, { type: 'User', login: VIEWER_LOGIN, id: VIEWER_ID }, sub) : { login: VIEWER_LOGIN };
      }
      if (name === 'repository') {
        const owner = args.owner as string;
        const repoName = args.name as string;
        const repo = ctx.forge.getRepo(owner, repoName);
        if (!repo) return null;
        return executeSelections(ctx, { type: 'Repository', forge: ctx.forge, repo }, sub);
      }
      if (name === 'node') {
        const id = args.id as string;
        const repo = ctx.forge.repoFromGlobalId(id);
        if (repo) return executeSelections(ctx, { type: 'Repository', forge: ctx.forge, repo }, sub);
        const issue = ctx.forge.issueFromGlobalId(id);
        if (issue) return executeSelections(ctx, { type: 'Issue', forge: ctx.forge, repo: issue.repo, issue: issue.issue }, sub);
        return null;
      }
      if (name === '__type') {
        return executeSelections(ctx, { type: '__Type', name: args.name as string }, sub);
      }
      fieldError(ctx, 'Query', name);
      return undefined;
    }
    case 'Mutation': {
      if (name === '__typename') return 'Mutation';
      if (name === 'createIssue') return mutateCreateIssue(ctx, args, sub);
      if (name === 'closeIssue') return mutateCloseIssue(ctx, args, sub);
      if (name === 'createPullRequest') return mutateCreatePullRequest(ctx, args, sub);
      if (name === 'mergePullRequest') return mutateMergePullRequest(ctx, args, sub);
      if (name === 'addComment') return mutateAddComment(ctx, args, sub);
      fieldError(ctx, 'Mutation', name);
      return undefined;
    }
    case 'User': {
      if (name === '__typename') return 'User';
      if (name === 'login') return tagged.login;
      if (name === 'id') return String(tagged.id);
      fieldError(ctx, 'User', name);
      return undefined;
    }
    case 'Repository': {
      const repo = tagged.repo;
      if (name === '__typename') return 'Repository';
      if (name === 'id') return ctx.forge.repoGlobalId(repo);
      if (name === 'databaseId') return repo.id;
      if (name === 'name') return repo.name;
      if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (name === 'description') return repo.description;
      if (name === 'isPrivate') return repo.private;
      if (name === 'createdAt' || name === 'updatedAt') return FROZEN_ISO;
      if (name === 'owner') {
        return sub.length > 0 ? executeSelections(ctx, { type: 'User', login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0 }, sub) : { login: repo.owner };
      }
      if (name === 'defaultBranchRef') {
        return executeSelections(ctx, { type: 'BranchRef', name: repo.defaultBranch }, sub);
      }
      if (name === 'viewerPermission') return 'ADMIN';
      if (name === 'hasIssuesEnabled') return true;
      if (name === 'issue') {
        const issue = repo.issues.find((candidate) => candidate.number === (args.number as number));
        if (!issue) return null;
        return executeSelections(ctx, { type: 'Issue', forge: ctx.forge, repo, issue }, sub);
      }
      if (name === 'issues') return issuesConnection(ctx, tagged, args, sub);
      if (name === 'pullRequest') {
        const pull = repo.pulls.find((candidate) => candidate.number === (args.number as number));
        if (!pull) return null;
        return executeSelections(ctx, { type: 'PullRequest', forge: ctx.forge, repo, pull }, sub);
      }
      if (name === 'pullRequests') {
        const first = typeof args.first === 'number' ? args.first : 30;
        const pulls = [...repo.pulls].sort((a, b) => b.seq - a.seq).slice(0, first);
        const nodes = pulls.map((pull) => executeSelections(ctx, { type: 'PullRequest', forge: ctx.forge, repo, pull }, subSelections(sub, 'nodes')));
        return { nodes, pageInfo: { hasNextPage: repo.pulls.length > first, endCursor: null } };
      }
      fieldError(ctx, 'Repository', name);
      return undefined;
    }
    case 'Issue': {
      const issue = tagged.issue;
      if (name === '__typename') return 'Issue';
      if (name === 'id') return ctx.forge.issueGlobalId(tagged.repo, issue);
      if (name === 'number') return issue.number;
      if (name === 'title') return issue.title;
      if (name === 'state') return issue.state.toUpperCase();
      if (name === 'body') return issue.body;
      if (name === 'createdAt' || name === 'updatedAt') return FROZEN_ISO;
      if (name === 'url') return `https://github.com/${tagged.repo.owner}/${tagged.repo.name}/issues/${issue.number}`;
      if (name === 'author') return { login: VIEWER_LOGIN };
      fieldError(ctx, 'Issue', name);
      return undefined;
    }
    case 'PullRequest': {
      const pull = tagged.pull;
      if (name === '__typename') return 'PullRequest';
      if (name === 'id') return ctx.forge.pullGlobalId(tagged.repo, pull);
      if (name === 'number') return pull.number;
      if (name === 'title') return pull.title;
      if (name === 'body') return pull.body;
      if (name === 'state') return pull.state.toUpperCase();
      if (name === 'merged') return pull.merged;
      if (name === 'mergeable') return ctx.forge.pullMergeable(tagged.repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
      if (name === 'headRefName') return pull.headRef;
      if (name === 'baseRefName') return pull.baseRef;
      if (name === 'headRefOid') return pull.headSha;
      if (name === 'baseRefOid') return pull.baseSha;
      if (name === 'createdAt' || name === 'updatedAt') return FROZEN_ISO;
      if (name === 'url') return `https://github.com/${tagged.repo.owner}/${tagged.repo.name}/pull/${pull.number}`;
      if (name === 'files') {
        const first = typeof args.first === 'number' ? args.first : 10;
        const files = ctx.forge.pullFiles(tagged.repo, pull).slice(0, first);
        const nodeSelections = subSelections(sub, 'nodes');
        return { nodes: files.map((file) => ({ path: file.filename })), pageInfo: { hasNextPage: false, endCursor: null }, totalCount: files.length };
      }
      fieldError(ctx, 'PullRequest', name);
      return undefined;
    }
    case 'IssueConnection': {
      if (name === '__typename') return 'IssueConnection';
      if (name === 'nodes') {
        const nodeSelections = subSelections(sub, 'nodes');
        void nodeSelections;
        return tagged.issues.map((issue) => executeSelections(ctx, { type: 'Issue', forge: ctx.forge, repo: tagged.repo, issue }, sub));
      }
      if (name === 'pageInfo') {
        return executeSelections(ctx, { type: 'PageInfo', hasNextPage: tagged.pageInfo.hasNextPage, endCursor: tagged.pageInfo.endCursor }, sub);
      }
      if (name === 'totalCount') return tagged.issues.length;
      fieldError(ctx, 'IssueConnection', name);
      return undefined;
    }
    case 'PullRequestConnection': {
      if (name === '__typename') return 'PullRequestConnection';
      if (name === 'nodes') {
        return tagged.pulls.map((pull) => executeSelections(ctx, { type: 'PullRequest', forge: ctx.forge, repo: tagged.repo, pull }, sub));
      }
      if (name === 'pageInfo') {
        return executeSelections(ctx, { type: 'PageInfo', hasNextPage: false, endCursor: null }, sub);
      }
      fieldError(ctx, 'PullRequestConnection', name);
      return undefined;
    }
    case 'PageInfo': {
      if (name === '__typename') return 'PageInfo';
      if (name === 'hasNextPage') return tagged.hasNextPage;
      if (name === 'endCursor') return tagged.endCursor;
      if (name === 'hasPreviousPage') return false;
      if (name === 'startCursor') return null;
      fieldError(ctx, 'PageInfo', name);
      return undefined;
    }
    case 'BranchRef': {
      if (name === '__typename') return 'BranchRef';
      if (name === 'name') return tagged.name;
      fieldError(ctx, 'BranchRef', name);
      return undefined;
    }
    case '__Type': {
      if (name === '__typename') return '__Type';
      if (name === 'name') return tagged.name;
      if (name === 'kind') return tagged.name === 'SearchType' ? 'ENUM' : 'OBJECT';
      if (name === 'fields') {
        const fields = TYPE_FIELDS[tagged.name] ?? [];
        return fields.map((fieldName) => ({ name: fieldName }));
      }
      if (name === 'enumValues') {
        if (tagged.name !== 'SearchType') return [];
        return SEARCH_TYPE_VALUES.map((value) => ({ name: value }));
      }
      fieldError(ctx, '__Type', name);
      return undefined;
    }
    case 'CreateIssuePayload': {
      if (name === '__typename') return 'CreateIssuePayload';
      if (name === 'issue') return executeSelections(ctx, { type: 'Issue', forge: ctx.forge, repo: tagged.repo, issue: tagged.issue }, sub);
      fieldError(ctx, 'CreateIssuePayload', name);
      return undefined;
    }
    case 'CloseIssuePayload': {
      if (name === '__typename') return 'CloseIssuePayload';
      if (name === 'issue') return executeSelections(ctx, { type: 'Issue', forge: ctx.forge, repo: tagged.repo, issue: tagged.issue }, sub);
      fieldError(ctx, 'CloseIssuePayload', name);
      return undefined;
    }
    case 'CreatePullRequestPayload': {
      if (name === '__typename') return 'CreatePullRequestPayload';
      if (name === 'pullRequest') return executeSelections(ctx, { type: 'PullRequest', forge: ctx.forge, repo: tagged.repo, pull: tagged.pull }, sub);
      fieldError(ctx, 'CreatePullRequestPayload', name);
      return undefined;
    }
    case 'MergePullRequestPayload': {
      if (name === '__typename') return 'MergePullRequestPayload';
      if (name === 'pullRequest') return executeSelections(ctx, { type: 'PullRequest', forge: ctx.forge, repo: tagged.repo, pull: tagged.pull }, sub);
      fieldError(ctx, 'MergePullRequestPayload', name);
      return undefined;
    }
    case 'AddCommentPayload': {
      if (name === '__typename') return 'AddCommentPayload';
      if (name === 'commentEdge') {
        return executeSelections(ctx, { type: 'CommentEdge', forge: ctx.forge, repo: tagged.repo, issue: tagged.issue, commentId: tagged.commentId, commentBody: tagged.commentBody }, sub);
      }
      fieldError(ctx, 'AddCommentPayload', name);
      return undefined;
    }
    case 'CommentEdge': {
      if (name === '__typename') return 'CommentEdge';
      if (name === 'node') {
        return executeSelections(ctx, { type: 'IssueComment', id: tagged.commentId, body: tagged.commentBody }, sub);
      }
      fieldError(ctx, 'CommentEdge', name);
      return undefined;
    }
    case 'IssueComment': {
      if (name === '__typename') return 'IssueComment';
      if (name === 'id') return b64urlEncode(`Comment:${tagged.id}`);
      if (name === 'body') return tagged.body;
      fieldError(ctx, 'IssueComment', name);
      return undefined;
    }
  }
}

/** The selections under a `nodes` field, for connection node execution. */
function subSelections(selections: Selection[], fieldName: string): Selection[] {
  for (const selection of selections) {
    if (selection.kind === 'field' && selection.name === fieldName) return selection.selections ?? [];
  }
  return selections;
}

function issuesConnection(ctx: Ctx, tagged: { forge: Forge; repo: Repo }, args: Record<string, unknown>, sub: Selection[]): Record<string, unknown> {
  const repo = tagged.repo;
  let issues = [...repo.issues];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    issues = issues.filter((issue) => wanted.has(issue.state.toUpperCase()));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  if (orderBy && String(orderBy.field ?? '').toUpperCase() === 'CREATED_AT') {
    issues.sort((a, b) => (String(orderBy.direction ?? 'ASC').toUpperCase() === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
  } else {
    issues.sort((a, b) => a.seq - b.seq);
  }
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    try {
      const text = b64urlDecode(args.after);
      const match = /^cursor:(\d+)$/.exec(text);
      if (match) start = Number(match[1]) + 1;
    } catch {
      start = 0;
    }
  }
  const first = typeof args.first === 'number' ? args.first : 30;
  const page = issues.slice(start, start + first);
  const hasNextPage = start + page.length < issues.length;
  const endCursor = page.length > 0 ? b64urlEncode(`cursor:${start + page.length - 1}`) : null;
  const nodeSelections = subSelections(sub, 'nodes');
  void nodeSelections;
  const connection: Tagged = {
    type: 'IssueConnection',
    forge: ctx.forge,
    repo,
    issues: page,
    pageInfo: { hasNextPage, endCursor },
  };
  // Execute the connection's own selections (nodes/pageInfo) against the page.
  const out: Record<string, unknown> = {};
  for (const selection of sub) {
    if (selection.kind !== 'field') continue;
    const key = selection.alias ?? selection.name!;
    const value = resolveField(ctx, connection, selection);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// mutations
// -------------------------------------------------------------------------------------------

function mutateCreateIssue(ctx: Ctx, args: Record<string, unknown>, sub: Selection[]): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const repo = ctx.forge.repoFromGlobalId(String(input.repositoryId ?? ''));
  if (!repo) {
    ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
    return null;
  }
  const title = String(input.title ?? '');
  if (title === '') {
    ctx.errors.push({ message: 'A title is required to create an issue.' });
    return null;
  }
  const issue = ctx.forge.createIssue(repo, title, String(input.body ?? ''), []);
  return executeSelections(ctx, { type: 'CreateIssuePayload', forge: ctx.forge, repo, issue }, sub);
}

function mutateCloseIssue(ctx: Ctx, args: Record<string, unknown>, sub: Selection[]): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const found = ctx.forge.issueFromGlobalId(String(input.issueId ?? ''));
  if (!found) {
    ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
    return null;
  }
  found.issue.state = 'closed';
  return executeSelections(ctx, { type: 'CloseIssuePayload', forge: ctx.forge, repo: found.repo, issue: found.issue }, sub);
}

function mutateCreatePullRequest(ctx: Ctx, args: Record<string, unknown>, sub: Selection[]): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const repo = ctx.forge.repoFromGlobalId(String(input.repositoryId ?? ''));
  if (!repo) {
    ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
    return null;
  }
  const head = String(input.headRefName ?? input.head ?? '');
  const base = String(input.baseRefName ?? input.base ?? '');
  const title = String(input.title ?? '');
  if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
    ctx.errors.push({ message: 'Head or base branch does not exist.' });
    return null;
  }
  const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
  if (duplicate) {
    ctx.errors.push({ message: 'A pull request already exists for these branches.' });
    return null;
  }
  const pull = ctx.forge.createPull(repo, title, String(input.body ?? ''), head, base);
  if (!pull) {
    ctx.errors.push({ message: 'Could not create the pull request.' });
    return null;
  }
  return executeSelections(ctx, { type: 'CreatePullRequestPayload', forge: ctx.forge, repo, pull }, sub);
}

function mutateMergePullRequest(ctx: Ctx, args: Record<string, unknown>, sub: Selection[]): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const found = ctx.forge.pullFromGlobalId(String(input.pullRequestId ?? ''));
  if (!found) {
    ctx.errors.push({ message: 'Could not resolve to a PullRequest with the global id.' });
    return null;
  }
  if (found.pull.state !== 'open') {
    ctx.errors.push({ message: 'Pull request is not open.' });
    return null;
  }
  const merged = ctx.forge.mergePull(found.repo, found.pull);
  if (merged === 'conflict' || !merged) {
    ctx.errors.push({ message: 'Merge conflict: the pull request cannot be merged.' });
    return null;
  }
  return executeSelections(ctx, { type: 'MergePullRequestPayload', forge: ctx.forge, repo: found.repo, pull: found.pull }, sub);
}

function mutateAddComment(ctx: Ctx, args: Record<string, unknown>, sub: Selection[]): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const found = ctx.forge.issueFromGlobalId(String(input.subjectId ?? ''));
  if (!found) {
    ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
    return null;
  }
  const comment = ctx.forge.createComment(found.repo, found.issue, String(input.body ?? ''));
  return executeSelections(
    ctx,
    { type: 'AddCommentPayload', forge: ctx.forge, repo: found.repo, issue: found.issue, commentId: comment.id, commentBody: comment.body },
    sub,
  );
}

// -------------------------------------------------------------------------------------------
// entry point
// -------------------------------------------------------------------------------------------

export interface GraphQLReply {
  status: number;
  body: unknown;
}

function executeOperation(forge: Forge, query: string, variables: Record<string, unknown>): Record<string, unknown> {
  const { operations, fragments } = new Parser(tokenize(query)).parseDocument();
  const operation = operations[0];
  if (!operation) return { data: null, errors: [{ message: 'No operation provided.' }] };
  const ctx: Ctx = { forge, variables, errors: [], fragments };
  const root: Tagged = operation.operation === 'mutation' ? { type: 'Mutation', forge } : { type: 'Query', forge };
  const data = executeSelections(ctx, root, operation.selections);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

export function handleGraphQL(forge: Forge, body: unknown): GraphQLReply {
  if (Array.isArray(body)) {
    const out: unknown[] = [];
    for (const entry of body) {
      const record = (entry ?? {}) as Record<string, unknown>;
      const query = typeof record.query === 'string' ? record.query : '';
      const variables = (record.variables ?? {}) as Record<string, unknown>;
      try {
        out.push(executeOperation(forge, query, variables));
      } catch (err) {
        out.push({ data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] });
      }
    }
    return { status: 200, body: out };
  }
  const record = (body ?? {}) as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query : '';
  const variables = (record.variables ?? {}) as Record<string, unknown>;
  if (query === '') return { status: 400, body: { errors: [{ message: 'No query provided.' }] } };
  try {
    return { status: 200, body: executeOperation(forge, query, variables) };
  } catch (err) {
    return { status: 200, body: { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] } };
  }
}
