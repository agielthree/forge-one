// Smart-HTTP git endpoints: v0/v2 advertisements, v2 ls-refs and fetch,
// v0 receive-pack. All framing follows the kit's git-client exactly.

import {
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  readPack,
  ZERO_OID,
  type GitObject,
} from './git.ts';
import { Forge, headRefName, type Repo } from './store.ts';
import { chunkBuffer, decodePktLines, PKT_DELIM, PKT_FLUSH, pktLine } from './util.ts';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'forge-one/1.0';

function v0Advertisement(
  service: 'git-upload-pack' | 'git-receive-pack',
  repo: Repo,
  capabilities: string,
): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = repo.refs;
  const headTip = repo.refs.get(headRefName(repo));
  if (refs.size === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
  } else {
    const headOid = headTip ?? [...refs.values()][0]!;
    parts.push(pktLine(`${headOid} HEAD\0${capabilities}\n`));
    for (const [name, oid] of [...refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (name === headRefName(repo)) {
        parts.push(pktLine(`${oid} ${name}\n`));
        continue;
      }
      parts.push(pktLine(`${oid} ${name}\n`));
      const object = repo.objects.get(oid);
      if (object?.type === 'tag') {
        const peeled = repoPeel(repo, oid);
        if (peeled) parts.push(pktLine(`${peeled} ${name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function repoPeel(repo: Repo, oid: string): string | null {
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

export function infoRefs(
  forge: Forge,
  repo: Repo | undefined,
  service: 'git-upload-pack' | 'git-receive-pack',
  gitProtocol: string | undefined,
): GitResponse {
  if (!repo) {
    return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8') };
  }
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-receive-pack') {
    const caps = `report-status side-band-64k delete-refs ofs-delta symref=HEAD:${headRefName(repo)} agent=${AGENT}`;
    return { status: 200, contentType, body: v0Advertisement(service, repo, caps) };
  }
  if (gitProtocol === 'version=2') {
    const parts: Buffer[] = [
      pktLine('# service=git-upload-pack\n'),
      PKT_FLUSH,
      pktLine('version 2\n'),
      pktLine(`agent=${AGENT}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow wait-for-done\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ];
    return { status: 200, contentType, body: Buffer.concat(parts) };
  }
  const caps = `symref=HEAD:${headRefName(repo)} agent=${AGENT}`;
  return { status: 200, contentType, body: v0Advertisement(service, repo, caps) };
}

export function lsRefsV2(forge: Forge, repo: Repo, body: Buffer): GitResponse {
  const decoded = decodePktLines(body);
  if (decoded.error) {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: decoded.error }), 'utf8') };
  }
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const packet of decoded.packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headTip = repo.refs.get(headRefName(repo));
  if (repo.refs.size === 0) {
    if (keep('HEAD')) parts.push(pktLine(`unborn HEAD symref-target:${headRefName(repo)}\n`));
  } else {
    if (headTip !== undefined && keep('HEAD')) {
      const symref = symrefs ? ` symref-target:${headRefName(repo)}` : '';
      parts.push(pktLine(`${headTip} HEAD${symref}\n`));
    }
    for (const { name, oid } of forge.sortedRefs(repo)) {
      if (!keep(name)) continue;
      let line = `${oid} ${name}`;
      if (peel) {
        const object = repo.objects.get(oid);
        if (object?.type === 'tag') {
          const peeled = repoPeel(repo, oid);
          if (peeled) line += ` peeled:${peeled}`;
        }
      }
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

export function fetchV2(forge: Forge, repo: Repo, body: Buffer): GitResponse {
  const decoded = decodePktLines(body);
  if (decoded.error) {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: decoded.error }), 'utf8') };
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let isFetch = false;
  for (const packet of decoded.packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'command=fetch') isFetch = true;
    else if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
  }
  if (!isFetch) {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'expected command=fetch' }), 'utf8') };
  }
  const result = forge.fetchPack(repo, wants, haves, shallow, depth);
  const parts: Buffer[] = [pktLine('acknowledgments\n')];
  if (result.acks.length > 0) {
    for (const ack of result.acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(PKT_DELIM);
  if (result.shallow.length > 0 || result.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of result.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of result.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  for (const chunk of chunkBuffer(result.pack, 32768)) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

export function receivePack(forge: Forge, repo: Repo, body: Buffer): GitResponse {
  const decoded = decodePktLines(body);
  if (decoded.error) {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: decoded.error }), 'utf8') };
  }
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  for (const packet of decoded.packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    line = line.replace(/\n$/, '');
    if (line === '') continue;
    const parts = line.split(' ');
    if (parts.length < 3 || !isOid(parts[0]!) || !isOid(parts[1]!)) {
      return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'bad push command' }), 'utf8') };
    }
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  if (commands.length === 0) {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'no push commands' }), 'utf8') };
  }
  const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (needsPack && decoded.rest.length > 0) {
    try {
      const pack = readPack(decoded.rest);
      for (const [oid, object] of pack.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  } else if (needsPack && decoded.rest.length === 0) {
    // A command list that creates or updates a ref without a pack is an unpack error
    // in real git; the client always sends one, so this is only a safety net.
    unpackOk = false;
    unpackDetail = 'unpack failed: no pack';
  }
  const reportLines: string[] = [unpackOk ? 'unpack ok' : `unpack ${unpackDetail}`];
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpack failed`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} remote ref does not exist`);
      } else {
        repo.refs.delete(command.ref);
        reportLines.push(`ok ${command.ref}`);
      }
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        reportLines.push(`ng ${command.ref} already exists`);
      } else if (!repo.objects.has(command.newOid)) {
        reportLines.push(`ng ${command.ref} object not found`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}`);
      }
      continue;
    }
    if (current === undefined) {
      reportLines.push(`ng ${command.ref} remote ref does not exist`);
    } else if (current !== command.oldOid) {
      reportLines.push(`ng ${command.ref} non-fast-forward`);
    } else if (command.newOid === command.oldOid) {
      reportLines.push(`ok ${command.ref}`);
    } else if (!repo.objects.has(command.newOid)) {
      reportLines.push(`ng ${command.ref} object not found`);
    } else if (!isAncestor(lookup, command.oldOid, command.newOid)) {
      reportLines.push(`ng ${command.ref} non-fast-forward`);
    } else {
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}`);
    }
  }
  const parts: Buffer[] = [];
  for (const line of reportLines) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.from(`${line}\n`, 'utf8')])));
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(parts) };
}
