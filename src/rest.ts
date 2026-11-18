// The GitHub REST v3 surface: /api/v3. Every reply is application/json with a
// non-empty X-GitHub-Request-Id; errors are {message: string}; a repository
// under any owner but the token's login is a 404, never a 403.

import { parseCommit } from './git.ts';
import { VIEWER_ID, VIEWER_LOGIN, Forge, headRefName, type Issue, type Pull, type Repo } from './store.ts';
import { FROZEN_ISO } from './util.ts';

export interface RestReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface RestRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  body: unknown;
  host: string;
}

function ok(body: unknown, status = 200, headers?: Record<string, string>): RestReply {
  return { status, body, headers };
}

function err(status: number, message: string): RestReply {
  return { status, body: { message } };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FROZEN_ISO,
    updated_at: FROZEN_ISO,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    fork: false,
    archived: false,
    disabled: false,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/repos/${repo.owner}/${repo.name}`,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    comments: issue.comments.length,
    created_at: FROZEN_ISO,
    updated_at: FROZEN_ISO,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: forge.pullMergeable(repo, pull),
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: FROZEN_ISO,
    updated_at: FROZEN_ISO,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function asRecord(body: unknown): Record<string, unknown> | null {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) return body as Record<string, unknown>;
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function handleRest(forge: Forge, req: RestRequest): RestReply {
  const segments = req.pathname.split('/').filter((part) => part !== '');
  // /api/v3[/...]
  if (segments[0] !== 'api' || segments[1] !== 'v3') return err(404, 'Not Found');
  const rest = segments.slice(2);

  if (rest.length === 0) {
    if (req.method !== 'GET') return err(404, 'Not Found');
    return ok({}, 200, { 'X-OAuth-Scopes': 'repo, read:org' });
  }

  if (rest[0] === 'meta' && rest.length === 1) {
    if (req.method !== 'GET') return err(404, 'Not Found');
    return ok({ installed_version: '1.0.0' });
  }

  if (rest[0] === 'user' && rest.length === 1) {
    if (req.method !== 'GET') return err(404, 'Not Found');
    return ok({ login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' });
  }

  if (rest[0] === 'user' && rest[1] === 'repos') {
    if (req.method === 'POST') {
      const body = asRecord(req.body);
      const name = body ? asString(body.name) : null;
      if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return err(422, 'Validation Failed: name is invalid');
      if (forge.getRepo(VIEWER_LOGIN, name)) return err(422, `Validation Failed: name already exists on this account`);
      const isPrivate = body?.private === true;
      const description = asString(body?.description) ?? '';
      const repo = forge.createRepo(VIEWER_LOGIN, name, isPrivate, description);
      return ok(repoJson(repo), 201);
    }
    if (req.method === 'GET') {
      const perPage = Math.max(1, Math.min(100, Number(req.query.get('per_page') ?? '30') || 30));
      const page = Math.max(1, Number(req.query.get('page') ?? '1') || 1);
      const all = forge.viewerRepos();
      const totalPages = Math.max(1, Math.ceil(all.length / perPage));
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const headers: Record<string, string> = {};
      const base = `http://${req.host}/api/v3/user/repos?per_page=${perPage}`;
      const links: string[] = [];
      if (page < totalPages) links.push(`<${base}&page=${page + 1}>; rel="next"`);
      if (page > 1) links.push(`<${base}&page=${page - 1}>; rel="prev"`);
      links.push(`<${base}&page=1>; rel="first"`);
      links.push(`<${base}&page=${totalPages}>; rel="last"`);
      headers.Link = links.join(', ');
      return ok(slice.map(repoJson), 200, headers);
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = decodeURIComponent(rest[1]!);
    const name = decodeURIComponent(rest[2]!);
    if (owner !== VIEWER_LOGIN) return err(404, 'Not Found');
    const repo = forge.getRepo(owner, name);
    if (!repo) return err(404, 'Not Found');
    return handleRepoRoute(forge, repo, req, rest.slice(3));
  }

  return err(404, 'Not Found');
}

function handleRepoRoute(forge: Forge, repo: Repo, req: RestRequest, tail: string[]): RestReply {
  const method = req.method;

  if (tail.length === 0) {
    if (method === 'GET') return ok(repoJson(repo));
    if (method === 'PATCH') {
      const body = asRecord(req.body);
      const description = body ? asString(body.description) : null;
      if (description !== null) repo.description = description;
      const name = body ? asString(body.name) : null;
      if (name !== null && name !== repo.name) {
        // Renames are not part of the contract; refuse rather than corrupt state.
        return err(422, 'Validation Failed: renaming is not supported');
      }
      return ok(repoJson(repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo.owner, repo.name);
      return { status: 204, body: null };
    }
    return err(404, 'Not Found');
  }

  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const body = asRecord(req.body);
      const ref = body ? asString(body.ref) : null;
      const sha = body ? asString(body.sha) : null;
      if (!ref || !ref.startsWith('refs/') || !sha) return err(422, 'Validation Failed: ref and sha are required');
      if (repo.refs.has(ref)) return err(422, 'Validation Failed: Reference already exists');
      if (!repo.objects.has(sha)) return err(422, 'Validation Failed: Object does not exist');
      repo.refs.set(ref, sha);
      return ok({ ref, object: { sha } }, 201);
    }
    if (method === 'GET' && tail.length >= 3) {
      const refName = tail.slice(2).map((part) => decodeURIComponent(part)).join('/');
      const sha = repo.refs.get(refName);
      if (!sha) return err(404, 'Not Found');
      return ok({ ref: refName, object: { sha } });
    }
    if (method === 'GET' && tail.length === 2) {
      return ok(forge.sortedRefs(repo).map(({ name, oid }) => ({ ref: name, object: { sha: oid } })));
    }
    return err(404, 'Not Found');
  }

  if (tail[0] === 'branches') {
    if (method === 'GET' && tail.length === 1) {
      const branches: Array<{ name: string; commit: { sha: string } }> = [];
      const defaultTip = repo.refs.get(headRefName(repo));
      if (defaultTip) branches.push({ name: repo.defaultBranch, commit: { sha: defaultTip } });
      for (const { name, oid } of forge.sortedRefs(repo)) {
        if (!name.startsWith('refs/heads/')) continue;
        const branch = name.slice('refs/heads/'.length);
        if (branch === repo.defaultBranch) continue;
        branches.push({ name: branch, commit: { sha: oid } });
      }
      return ok(branches);
    }
    if (method === 'GET' && tail.length === 2) {
      const branch = decodeURIComponent(tail[1]!);
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (!tip) return err(404, 'Not Found');
      return ok({ name: branch, commit: { sha: tip }, protected: false });
    }
    return err(404, 'Not Found');
  }

  if (tail[0] === 'commits') {
    if (method === 'GET' && tail.length === 1) {
      const shaParam = req.query.get('sha');
      let tip: string | undefined;
      if (shaParam) {
        tip = repo.refs.get(`refs/heads/${shaParam}`) ?? repo.refs.get(shaParam) ?? (repo.objects.has(shaParam) ? shaParam : undefined);
      } else {
        tip = repo.refs.get(headRefName(repo));
      }
      if (!tip) return err(404, 'Not Found');
      const commits = forge.commitsFrom(repo, tip).map((sha) => {
        const object = repo.objects.get(sha)!;
        const view = parseCommit(object.data);
        return {
          sha,
          commit: {
            message: view.message,
            tree: { sha: view.tree },
            author: { name: 'adaiversen', email: 'adaiversen@users.noreply.github.com', date: FROZEN_ISO },
            committer: { name: 'adaiversen', email: 'adaiversen@users.noreply.github.com', date: FROZEN_ISO },
          },
          parents: view.parents.map((parent) => ({ sha: parent })),
        };
      });
      return ok(commits);
    }
    return err(404, 'Not Found');
  }

  if (tail[0] === 'contents') {
    return handleContents(forge, repo, req, tail.slice(1));
  }

  if (tail[0] === 'labels') {
    if (method === 'POST' && tail.length === 1) {
      const body = asRecord(req.body);
      const name = body ? asString(body.name) : null;
      const color = body ? asString(body.color) : null;
      if (!name) return err(422, 'Validation Failed: name is required');
      if (repo.labels.some((label) => label.name === name)) return err(422, 'Validation Failed: label already exists');
      const label = forge.createLabel(repo, name, color ?? 'ededed');
      return ok({ name: label.name, color: label.color }, 201);
    }
    if (method === 'GET' && tail.length === 1) {
      return ok(repo.labels.map((label) => ({ name: label.name, color: label.color })));
    }
    return err(404, 'Not Found');
  }

  if (tail[0] === 'issues') {
    return handleIssues(forge, repo, req, tail.slice(1));
  }

  if (tail[0] === 'pulls') {
    return handlePulls(forge, repo, req, tail.slice(1));
  }

  return err(404, 'Not Found');
}

function resolveRefTip(repo: Repo, ref: string | null): string | undefined {
  if (!ref) return repo.refs.get(headRefName(repo));
  return (
    repo.refs.get(`refs/heads/${ref}`) ??
    repo.refs.get(ref) ??
    (repo.objects.has(ref) ? ref : undefined)
  );
}

function handleContents(forge: Forge, repo: Repo, req: RestRequest, tail: string[]): RestReply {
  const method = req.method;
  const path = tail.map((part) => decodeURIComponent(part)).join('/');
  if (path === '') return err(404, 'Not Found');

  if (method === 'GET') {
    const tip = resolveRefTip(repo, req.query.get('ref'));
    if (!tip) return err(404, 'Not Found');
    const object = repo.objects.get(tip);
    if (!object || object.type !== 'commit') return err(404, 'Not Found');
    const treeOid = parseCommit(object.data).tree;
    const entry = forge.treeEntry(repo, treeOid, path);
    if (!entry) return err(404, 'Not Found');
    if (entry.type === 'tree') {
      const children = forge.listDir(repo, treeOid, path) ?? [];
      return ok(
        children.map((child) => ({
          type: child.mode === '40000' ? 'dir' : 'file',
          name: child.name,
          path: `${path}/${child.name}`,
          sha: child.oid,
          size: child.mode === '40000' ? 0 : (repo.objects.get(child.oid)?.data.length ?? 0),
        })),
      );
    }
    const blob = repo.objects.get(entry.oid);
    if (!blob) return err(404, 'Not Found');
    return ok({
      type: 'file',
      encoding: 'base64',
      content: blob.data.toString('base64'),
      sha: entry.oid,
      size: blob.data.length,
      name: path.split('/').pop(),
      path,
    });
  }

  if (method === 'PUT') {
    const body = asRecord(req.body);
    const message = body ? asString(body.message) : null;
    const content = body ? asString(body.content) : null;
    if (!message || content === null) return err(422, 'Validation Failed: message and content are required');
    const branch = body && asString(body.branch) ? asString(body.branch)! : repo.defaultBranch;
    const sha = body ? asString(body.sha) : null;
    let tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) {
      const defaultTip = repo.refs.get(headRefName(repo));
      if (defaultTip === undefined && branch !== repo.defaultBranch) {
        return err(422, 'Validation Failed: branch does not exist');
      }
      if (defaultTip !== undefined) {
        // A new branch starts at the default tip.
        repo.refs.set(`refs/heads/${branch}`, defaultTip);
        tip = defaultTip;
      }
    }
    const current = tip === undefined ? null : forge.treeEntry(repo, parseCommit(repo.objects.get(tip)!.data).tree, path);
    const exists = current !== null && current.type !== 'tree';
    if (sha !== null) {
      if (!exists || current!.oid !== sha) return err(409, 'Conflict: sha does not match the current blob');
    } else if (exists) {
      return err(409, 'Conflict: sha is required to update a file');
    }
    let contentBytes: Buffer;
    try {
      contentBytes = Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
    } catch {
      return err(422, 'Validation Failed: content is not valid base64');
    }
    const { commitSha, blobSha } = forge.commitBlob(repo, branch, path, contentBytes, message);
    return ok(
      {
        content: { name: path.split('/').pop(), path, sha: blobSha, size: contentBytes.length, type: 'file', encoding: 'base64' },
        commit: { sha: commitSha, message },
      },
      exists ? 200 : 201,
    );
  }

  if (method === 'DELETE') {
    const body = asRecord(req.body);
    const message = body ? asString(body.message) : 'Delete file';
    const branch = body && asString(body.branch) ? asString(body.branch)! : repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (!tip) return err(404, 'Not Found');
    const current = forge.treeEntry(repo, parseCommit(repo.objects.get(tip)!.data).tree, path);
    if (!current || current.type === 'tree') return err(404, 'Not Found');
    const deleted = forge.deleteBlob(repo, branch, path, message);
    if (!deleted) return err(404, 'Not Found');
    return ok({ commit: { sha: deleted.commitSha, message } });
  }

  return err(404, 'Not Found');
}

function handleIssues(forge: Forge, repo: Repo, req: RestRequest, tail: string[]): RestReply {
  const method = req.method;

  if (tail.length === 0) {
    if (method === 'POST') {
      const body = asRecord(req.body);
      const title = body ? asString(body.title) : null;
      if (!title) return err(422, 'Validation Failed: title is required');
      const bodyText = body ? asString(body.body) ?? '' : '';
      const labelNames = Array.isArray(body?.labels) ? (body!.labels as unknown[]) : [];
      const labels: Array<{ name: string; color: string }> = [];
      for (const name of labelNames) {
        if (typeof name !== 'string') continue;
        const label = repo.labels.find((candidate) => candidate.name === name);
        if (!label) return err(422, `Validation Failed: label "${name}" does not exist`);
        labels.push(label);
      }
      const issue = forge.createIssue(repo, title, bodyText, labels);
      return ok(issueJson(repo, issue), 201);
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const sort = req.query.get('sort') ?? 'created';
      const direction = req.query.get('direction') ?? 'desc';
      let issues = [...repo.issues];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      return ok(issues.map((issue) => issueJson(repo, issue)));
    }
    return err(404, 'Not Found');
  }

  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
  const issue = repo.issues.find((candidate) => candidate.number === number);
  if (!issue) return err(404, 'Not Found');

  if (tail.length === 1) {
    if (method === 'GET') return ok(issueJson(repo, issue));
    if (method === 'PATCH') {
      const body = asRecord(req.body);
      if (body) {
        const state = asString(body.state);
        if (state === 'open' || state === 'closed') issue.state = state;
        const title = asString(body.title);
        if (title !== null) issue.title = title;
        const bodyText = asString(body.body);
        if (bodyText !== null) issue.body = bodyText;
      }
      return ok(issueJson(repo, issue));
    }
    return err(404, 'Not Found');
  }

  if (tail[1] === 'comments') {
    if (method === 'POST' && tail.length === 2) {
      const body = asRecord(req.body);
      const text = body ? asString(body.body) : null;
      if (text === null) return err(422, 'Validation Failed: body is required');
      const comment = forge.createComment(repo, issue, text);
      return ok({ id: comment.id, body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, created_at: FROZEN_ISO, updated_at: FROZEN_ISO }, 201);
    }
    if (method === 'GET' && tail.length === 2) {
      return ok(
        issue.comments.map((comment) => ({
          id: comment.id,
          body: comment.body,
          user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
          created_at: FROZEN_ISO,
          updated_at: FROZEN_ISO,
        })),
      );
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

function handlePulls(forge: Forge, repo: Repo, req: RestRequest, tail: string[]): RestReply {
  const method = req.method;

  if (tail.length === 0) {
    if (method === 'POST') {
      const body = asRecord(req.body);
      const head = body ? asString(body.head) : null;
      const base = body ? asString(body.base) : null;
      const title = body ? asString(body.title) : null;
      if (!head || !base || !title) return err(422, 'Validation Failed: head, base and title are required');
      if (!repo.refs.has(`refs/heads/${head}`)) return err(422, `Validation Failed: head branch "${head}" does not exist`);
      if (!repo.refs.has(`refs/heads/${base}`)) return err(422, `Validation Failed: base branch "${base}" does not exist`);
      const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (duplicate) return err(422, 'Validation Failed: A pull request already exists for these branches');
      const bodyText = body ? asString(body.body) ?? '' : '';
      const pull = forge.createPull(repo, title, bodyText, head, base);
      if (!pull) return err(422, 'Validation Failed: could not create the pull request');
      return ok(pullJson(forge, repo, pull), 201);
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let pulls = [...repo.pulls];
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.seq - a.seq);
      return ok(pulls.map((pull) => pullJson(forge, repo, pull)));
    }
    return err(404, 'Not Found');
  }

  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
  const pull = repo.pulls.find((candidate) => candidate.number === number);
  if (!pull) return err(404, 'Not Found');

  if (tail.length === 1) {
    if (method === 'GET') return ok(pullJson(forge, repo, pull));
    return err(404, 'Not Found');
  }

  if (tail[1] === 'files' && tail.length === 2) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(forge.pullFiles(repo, pull));
  }

  if (tail[1] === 'merge' && tail.length === 2) {
    if (method !== 'PUT') return err(404, 'Not Found');
    if (pull.state !== 'open') return err(405, 'Validation Failed: pull request is not open');
    const merged = forge.mergePull(repo, pull);
    if (merged === 'conflict' || !merged) return err(405, 'Merge conflict: the pull request cannot be merged');
    return ok({ sha: merged.sha, merged: true, message: `Merge pull request #${pull.number} from ${pull.headRef}` });
  }

  return err(404, 'Not Found');
}
