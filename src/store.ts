// The forge's in-memory store: repositories, git objects, issues, pull requests,
// labels and comments, plus the content-tree operations and merges the REST,
// GraphQL and MCP surfaces all share. One process, one store, no clock reads.

import {
  buildCommit,
  buildTree,
  closureObjects,
  closureOfExact,
  collectAncestors,
  hashObject,
  mergeBase as gitMergeBase,
  parseCommit,
  parseTag,
  parseTree,
  storeObject,
  writePack,
  type GitObject,
  type ObjType,
} from './git.ts';
import { b64urlDecode, b64urlEncode, FROZEN_EPOCH, FROZEN_ISO } from './util.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;

export const COMMIT_AUTHOR = `adaiversen <adaiversen@users.noreply.github.com> ${FROZEN_EPOCH} +0000`;

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  seq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  seq: number;
  comments: Comment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  nextIssueNumber: number;
  nextPullNumber: number;
}

export function headRefName(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

export class Forge {
  repos = new Map<string, Repo>();
  nextRepoId = 5000;
  nextIssueId = 1;
  nextPullId = 1;
  nextCommentId = 1;
  seq = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      private: isPrivate,
      description,
      defaultBranch: 'main',
      createdSeq: ++this.seq,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  viewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === VIEWER_LOGIN) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  lookup(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  headRefName(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  /** All refs sorted: HEAD's target first, then heads, then tags, each by name. */
  sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
    const heads: Array<{ name: string; oid: string }> = [];
    const tags: Array<{ name: string; oid: string }> = [];
    const other: Array<{ name: string; oid: string }> = [];
    for (const [name, oid] of repo.refs) {
      if (name.startsWith('refs/heads/')) heads.push({ name, oid });
      else if (name.startsWith('refs/tags/')) tags.push({ name, oid });
      else other.push({ name, oid });
    }
    heads.sort((a, b) => (a.name < b.name ? -1 : 1));
    tags.sort((a, b) => (a.name < b.name ? -1 : 1));
    other.sort((a, b) => (a.name < b.name ? -1 : 1));
    return [...heads, ...tags, ...other];
  }

  /** The commit a tag object peels to (following nested tags). */
  peelToCommit(repo: Repo, oid: string): string | null {
    let current = oid;
    for (let depth = 0; depth < 10; depth += 1) {
      const object = repo.objects.get(current);
      if (!object) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  // -----------------------------------------------------------------------------------------
  // trees
  // -----------------------------------------------------------------------------------------

  /** Resolve `path` (slash-separated, no leading slash) in the tree at `treeOid`. */
  treeEntry(repo: Repo, treeOid: string, path: string): { mode: string; oid: string; type: ObjType } | null {
    const segments = path.split('/').filter((part) => part !== '');
    let current = treeOid;
    for (let index = 0; index < segments.length; index += 1) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
      if (!entry) return null;
      if (index === segments.length - 1) {
        const child = repo.objects.get(entry.oid);
        const type: ObjType = entry.mode === '40000' ? 'tree' : child?.type ?? 'blob';
        return { mode: entry.mode, oid: entry.oid, type };
      }
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  /** Direct children of the directory at `dirPath` ('' for the root) in `treeOid`. */
  listDir(repo: Repo, treeOid: string, dirPath: string): TreeEntry[] | null {
    let current = treeOid;
    if (dirPath !== '') {
      const entry = this.treeEntry(repo, treeOid, dirPath);
      if (!entry || entry.type !== 'tree') return null;
      current = entry.oid;
    }
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    return parseTree(object.data);
  }

  /** Flat map of every file path under the tree at `treeOid`. */
  flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  private writeTree(repo: Repo, entries: Array<{ mode: string; name: string; oid: string }>): string {
    return storeObject(repo.objects, 'tree', buildTree(entries));
  }

  /** Return a new root tree with `path` set to `blobOid` (creating directories). */
  setPath(repo: Repo, baseTreeOid: string | null, path: string, blobOid: string, mode = '100644'): string {
    const segments = path.split('/').filter((part) => part !== '');
    const build = (treeOid: string | null, depth: number): string => {
      const entries = treeOid === null ? [] : parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0));
      const name = segments[depth]!;
      if (depth === segments.length - 1) {
        const next = entries.filter((entry) => entry.name !== name);
        next.push({ mode, name, oid: blobOid });
        return this.writeTree(repo, next);
      }
      const existing = entries.find((entry) => entry.name === name);
      const childTree = existing && existing.mode === '40000' ? existing.oid : null;
      const newChild = build(childTree, depth + 1);
      const next = entries.filter((entry) => entry.name !== name);
      next.push({ mode: '40000', name, oid: newChild });
      return this.writeTree(repo, next);
    };
    return build(baseTreeOid, 0);
  }

  /** Return a new root tree with `path` removed, or null when the tree becomes empty. */
  removePath(repo: Repo, baseTreeOid: string, path: string): string | null {
    const segments = path.split('/').filter((part) => part !== '');
    const build = (treeOid: string, depth: number): string | null => {
      const entries = parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0));
      const name = segments[depth]!;
      if (depth === segments.length - 1) {
        const next = entries.filter((entry) => entry.name !== name);
        if (next.length === entries.length) return null; // path not present
        return this.writeTree(repo, next);
      }
      const existing = entries.find((entry) => entry.name === name);
      if (!existing || existing.mode !== '40000') return treeOid;
      const newChild = build(existing.oid, depth + 1);
      if (newChild === null) return null; // path not present below
      const next = entries.filter((entry) => entry.name !== name);
      next.push({ mode: '40000', name, oid: newChild });
      return this.writeTree(repo, next);
    };
    return build(baseTreeOid, 0);
  }

  // -----------------------------------------------------------------------------------------
  // commits through the contents API
  // -----------------------------------------------------------------------------------------

  commitBlob(repo: Repo, branch: string, path: string, content: Buffer, message: string): { commitSha: string; blobSha: string } {
    const tip = this.branchTip(repo, branch);
    const parentTree = tip === undefined ? null : parseCommit(repo.objects.get(tip)!.data).tree;
    const blobSha = storeObject(repo.objects, 'blob', content);
    const treeSha = this.setPath(repo, parentTree, path, blobSha);
    const commitData = buildCommit({
      tree: treeSha,
      parents: tip === undefined ? [] : [tip],
      message,
      author: COMMIT_AUTHOR,
      committer: COMMIT_AUTHOR,
    });
    const commitSha = storeObject(repo.objects, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha, blobSha };
  }

  deleteBlob(repo: Repo, branch: string, path: string, message: string): { commitSha: string } | null {
    const tip = this.branchTip(repo, branch);
    if (tip === undefined) return null;
    const parentTree = parseCommit(repo.objects.get(tip)!.data).tree;
    const treeSha = this.removePath(repo, parentTree, path);
    if (treeSha === null) return null;
    const commitData = buildCommit({
      tree: treeSha,
      parents: [tip],
      message,
      author: COMMIT_AUTHOR,
      committer: COMMIT_AUTHOR,
    });
    const commitSha = storeObject(repo.objects, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha };
  }

  /** Commits reachable from `tip`, newest first (parents before their ancestors). */
  commitsFrom(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
        continue;
      }
      if (object.type !== 'commit') continue;
      seen.add(oid);
      out.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return out;
  }

  // -----------------------------------------------------------------------------------------
  // fetch computation (upload-pack v2)
  // -----------------------------------------------------------------------------------------

  fetchPack(
    repo: Repo,
    wants: string[],
    haves: string[],
    shallowBoundaries: string[],
    depth: number | null,
  ): { pack: Buffer; shallow: string[]; unshallow: string[]; acks: string[] } {
    const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
    // What the client already holds: the ancestry of its haves — except below
    // a shallow boundary, where its clone stops. A deepen must re-deliver
    // what lies below an old boundary, so cut the walk there.
    const shallowSet = new Set(shallowBoundaries);
    const haveAncestors = collectAncestors(lookup, haves, shallowSet);
    const haveClosure = closureObjects(lookup, haves, shallowSet);
    const acks = haves.filter((have) => repo.objects.has(have));
    // Distances from the nearest want, following commit parents (and tag targets).
    const distance = new Map<string, number>();
    const queue: Array<{ oid: string; dist: number }> = wants.map((oid) => ({ oid, dist: 0 }));
    const inWindow = new Set<string>();
    while (queue.length > 0) {
      const { oid, dist } = queue.shift()!;
      if (distance.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      distance.set(oid, dist);
      inWindow.add(oid);
      if (depth !== null && dist >= depth - 1) continue;
      if (object.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, dist: dist + 1 });
      } else if (object.type === 'tag') {
        queue.push({ oid: parseTag(object.data).object, dist: dist + 1 });
      }
    }
    // Commits/tags to send. Without a depth the have cut is by ancestry (nothing the
    // client holds is re-sent); with a depth the window is measured from the wants and
    // only the haves themselves are withheld, so a deepen past a shallow boundary
    // still delivers the generation below it.
    const haveSet = new Set(haves);
    const toSendTips = new Set(
      [...inWindow].filter((oid) => (depth !== null ? !haveSet.has(oid) : !haveAncestors.has(oid))),
    );
    const toSend = closureOfExact(lookup, [...toSendTips]);
    for (const oid of haveClosure.keys()) toSend.delete(oid);
    // A want that is itself a blob/tree (not a commit/tag) still ships with its closure.
    for (const want of wants) {
      const object = repo.objects.get(want);
      if (!object || haveClosure.has(want)) continue;
      if (object.type === 'blob') toSend.set(want, object);
      else if (object.type === 'tree') {
        toSend.set(want, object);
        for (const [, entry] of this.flattenTree(repo, want)) {
          const child = repo.objects.get(entry.oid);
          if (child && !haveClosure.has(entry.oid)) toSend.set(entry.oid, child);
        }
      }
    }
    // Shallow boundaries: wanted commits at distance depth-1 that still have parents.
    // An old boundary whose parents are now sent is no longer shallow.
    const shallow: string[] = [];
    const unshallow: string[] = [];
    if (depth !== null) {
      for (const [oid, dist] of distance) {
        if (dist !== depth - 1) continue;
        const object = repo.objects.get(oid);
        if (object?.type === 'commit' && parseCommit(object.data).parents.length > 0) shallow.push(oid);
      }
      for (const boundary of shallowBoundaries) {
        if (shallow.includes(boundary)) continue;
        const object = repo.objects.get(boundary);
        if (object?.type !== 'commit') continue;
        const parents = parseCommit(object.data).parents;
        if (parents.length > 0 && parents.every((parent) => toSendTips.has(parent))) {
          unshallow.push(boundary);
        }
      }
    }
    const objects = [...toSend.values()].sort((a, b) => {
      const ao = hashObject(a.type, a.data);
      const bo = hashObject(b.type, b.data);
      return ao < bo ? -1 : 1;
    });
    return { pack: writePack(objects), shallow, unshallow, acks };
  }

  // -----------------------------------------------------------------------------------------
  // issues, labels, comments
  // -----------------------------------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const issue: Issue = {
      id: this.nextIssueId++,
      number: repo.nextIssueNumber++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      seq: ++this.seq,
      comments: [],
    };
    repo.issues.push(issue);
    return issue;
  }

  createComment(repo: Repo, issue: Issue, body: string): Comment {
    const comment: Comment = { id: this.nextCommentId++, body, seq: ++this.seq };
    issue.comments.push(comment);
    return comment;
  }

  createLabel(repo: Repo, name: string, color: string): Label {
    const label: Label = { name, color };
    repo.labels.push(label);
    return label;
  }

  // -----------------------------------------------------------------------------------------
  // pull requests
  // -----------------------------------------------------------------------------------------

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | null {
    const headSha = this.branchTip(repo, headRef);
    const baseSha = this.branchTip(repo, baseRef);
    if (headSha === undefined || baseSha === undefined) return null;
    const pull: Pull = {
      id: this.nextPullId++,
      number: repo.nextPullNumber++,
      title,
      body,
      state: 'open',
      merged: false,
      headRef,
      baseRef,
      headSha,
      baseSha,
      seq: ++this.seq,
      mergedAt: null,
      mergeCommitSha: null,
    };
    repo.pulls.push(pull);
    return pull;
  }

  /** Line diff between two blobs (LCS over lines; falls back to full counts when huge). */
  diffBlobs(base: Buffer | null, head: Buffer | null): { additions: number; deletions: number } {
    if (base === null && head === null) return { additions: 0, deletions: 0 };
    if (base === null) return { additions: head!.toString('utf8').split('\n').length, deletions: 0 };
    if (head === null) return { additions: 0, deletions: base.toString('utf8').split('\n').length };
    const a = base.toString('utf8').split('\n');
    const b = head.toString('utf8').split('\n');
    if (a.length > 2000 || b.length > 2000) {
      return { additions: b.length, deletions: a.length };
    }
    // LCS length via two rows.
    let prev = new Uint32Array(b.length + 1);
    let curr = new Uint32Array(b.length + 1);
    for (let i = 1; i <= a.length; i += 1) {
      for (let j = 1; j <= b.length; j += 1) {
        curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
      }
      const tmp = prev;
      prev = curr;
      curr = tmp;
    }
    const lcs = prev[b.length];
    return { additions: b.length - lcs, deletions: a.length - lcs };
  }

  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const baseTip = repo.objects.get(pull.baseSha);
    const headTip = repo.objects.get(pull.headSha);
    if (!baseTip || !headTip || baseTip.type !== 'commit' || headTip.type !== 'commit') return [];
    const baseFiles = this.flattenTree(repo, parseCommit(baseTip.data).tree);
    const headFiles = this.flattenTree(repo, parseCommit(headTip.data).tree);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    for (const path of [...paths].sort()) {
      const baseEntry = baseFiles.get(path);
      const headEntry = headFiles.get(path);
      if (baseEntry && !headEntry) {
        const baseBlob = repo.objects.get(baseEntry.oid)?.data ?? null;
        const counts = this.diffBlobs(baseBlob, null);
        out.push({ filename: path, status: 'removed', additions: 0, deletions: counts.deletions, changes: counts.deletions });
      } else if (!baseEntry && headEntry) {
        const headBlob = repo.objects.get(headEntry.oid)?.data ?? null;
        const counts = this.diffBlobs(null, headBlob);
        out.push({ filename: path, status: 'added', additions: counts.additions, deletions: 0, changes: counts.additions });
      } else if (baseEntry && headEntry && baseEntry.oid !== headEntry.oid) {
        const baseBlob = repo.objects.get(baseEntry.oid)?.data ?? null;
        const headBlob = repo.objects.get(headEntry.oid)?.data ?? null;
        const counts = this.diffBlobs(baseBlob, headBlob);
        out.push({
          filename: path,
          status: 'modified',
          additions: counts.additions,
          deletions: counts.deletions,
          changes: counts.additions + counts.deletions,
        });
      }
    }
    return out;
  }

  /** Three-way merge of head into base; null when the merge conflicts. */
  mergeTrees(
    repo: Repo,
    baseTip: string,
    headTip: string,
    mergeBaseTip: string,
  ): { treeOid: string } | { conflict: true } {
    const baseCommit = repo.objects.get(baseTip);
    const headCommit = repo.objects.get(headTip);
    const mergeCommit = repo.objects.get(mergeBaseTip);
    if (!baseCommit || !headCommit || !mergeCommit) return { conflict: true };
    if (baseCommit.type !== 'commit' || headCommit.type !== 'commit' || mergeCommit.type !== 'commit') {
      return { conflict: true };
    }
    const baseFiles = this.flattenTree(repo, parseCommit(baseCommit.data).tree);
    const headFiles = this.flattenTree(repo, parseCommit(headCommit.data).tree);
    const mergeFiles = this.flattenTree(repo, parseCommit(mergeCommit.data).tree);
    const merged = new Map<string, { oid: string; mode: string }>();
    for (const [path, entry] of baseFiles) merged.set(path, entry);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...mergeFiles.keys()]);
    for (const path of paths) {
      const base = baseFiles.get(path)?.oid ?? null;
      const head = headFiles.get(path)?.oid ?? null;
      const ancestor = mergeFiles.get(path)?.oid ?? null;
      if (head === base) continue;
      if (head === ancestor) continue; // head unchanged: keep base
      if (base === ancestor) {
        // base unchanged: take head (or delete when head is gone)
        if (head === null) merged.delete(path);
        else merged.set(path, headFiles.get(path)!);
        continue;
      }
      return { conflict: true };
    }
    // Rebuild the tree from the merged flat map.
    const buildDir = (prefix: string): string | null => {
      const entries: Array<{ mode: string; name: string; oid: string }> = [];
      const children = new Set<string>();
      for (const [path, entry] of merged) {
        const rel = prefix === '' ? path : path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : null;
        if (rel === null) continue;
        const slash = rel.indexOf('/');
        if (slash < 0) entries.push({ mode: entry.mode, name: rel, oid: entry.oid });
        else children.add(rel.slice(0, slash));
      }
      for (const child of children) {
        const childOid = buildDir(prefix === '' ? child : `${prefix}/${child}`);
        if (childOid !== null) entries.push({ mode: '40000', name: child, oid: childOid });
      }
      if (entries.length === 0) return null;
      return storeObject(repo.objects, 'tree', buildTree(entries));
    };
    let root = buildDir('');
    if (root === null) {
      // Empty tree.
      root = storeObject(repo.objects, 'tree', buildTree([]));
    }
    return { treeOid: root };
  }

  /** Is the pull mergeable right now (open and conflict-free)? */
  pullMergeable(repo: Repo, pull: Pull): boolean {
    if (pull.state !== 'open') return false;
    const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const base = gitMergeBase(lookup, pull.headSha, baseTip);
    if (base === null) return false;
    if (pull.headSha === baseTip) return false;
    const merged = this.mergeTrees(repo, baseTip, pull.headSha, base);
    return !('conflict' in merged);
  }

  /** Squash-merge the pull into its base branch. Returns the merge commit sha, or null on conflict. */
  mergePull(repo: Repo, pull: Pull): { sha: string } | 'conflict' | null {
    if (pull.state !== 'open') return null;
    const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
    // Merge against the CURRENT base branch tip, not the tip recorded when the
    // PR was created: a sibling PR may have merged into the base since.
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const base = gitMergeBase(lookup, pull.headSha, baseTip);
    if (base === null) return null;
    const merged = this.mergeTrees(repo, baseTip, pull.headSha, base);
    if ('conflict' in merged) return 'conflict';
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
    const commitData = buildCommit({
      tree: merged.treeOid,
      parents: [baseTip],
      message,
      author: COMMIT_AUTHOR,
      committer: COMMIT_AUTHOR,
    });
    const sha = storeObject(repo.objects, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FROZEN_ISO;
    pull.mergeCommitSha = sha;
    return { sha };
  }

  // -----------------------------------------------------------------------------------------
  // global ids (opaque, stable)
  // -----------------------------------------------------------------------------------------

  repoGlobalId(repo: Repo): string {
    return b64urlEncode(`Repository:${repo.owner}/${repo.name}`);
  }

  issueGlobalId(repo: Repo, issue: Issue): string {
    return b64urlEncode(`Issue:${repo.owner}/${repo.name}#${issue.number}`);
  }

  pullGlobalId(repo: Repo, pull: Pull): string {
    return b64urlEncode(`PullRequest:${repo.owner}/${repo.name}#${pull.number}`);
  }

  commentGlobalId(comment: Comment): string {
    return b64urlEncode(`Comment:${comment.id}`);
  }

  repoFromGlobalId(id: string): Repo | null {
    try {
      const text = b64urlDecode(id);
      const match = /^Repository:(.+)\/(.+)$/.exec(text);
      if (!match) return null;
      return this.getRepo(match[1]!, match[2]!) ?? null;
    } catch {
      return null;
    }
  }

  issueFromGlobalId(id: string): { repo: Repo; issue: Issue } | null {
    try {
      const text = b64urlDecode(id);
      const match = /^Issue:(.+)\/(.+)#(\d+)$/.exec(text);
      if (!match) return null;
      const repo = this.getRepo(match[1]!, match[2]!);
      if (!repo) return null;
      const issue = repo.issues.find((candidate) => candidate.number === Number(match[3]));
      return issue ? { repo, issue } : null;
    } catch {
      return null;
    }
  }

  pullFromGlobalId(id: string): { repo: Repo; pull: Pull } | null {
    try {
      const text = b64urlDecode(id);
      const match = /^PullRequest:(.+)\/(.+)#(\d+)$/.exec(text);
      if (!match) return null;
      const repo = this.getRepo(match[1]!, match[2]!);
      if (!repo) return null;
      const pull = repo.pulls.find((candidate) => candidate.number === Number(match[3]));
      return pull ? { repo, pull } : null;
    } catch {
      return null;
    }
  }
}
