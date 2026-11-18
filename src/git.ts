// Git object model: loose-object hashing, tree/commit/tag parse and build,
// packfile read (plain objects, plus delta resolution for completeness) and
// write (plain objects only), reachability and ancestry over an object store.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([head, data]));
}

export function storeObject(objects: Map<string, GitObject>, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's canonical tree order: names compare as if directories had a trailing '/'. */
export function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const sep = text.indexOf('\n\n');
  const head = sep < 0 ? text : text.slice(0, sep);
  const message = sep < 0 ? '' : text.slice(sep + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, message, author, committer };
}

export function buildCommit(fields: {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
}): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const sep = text.indexOf('\n\n');
  const head = sep < 0 ? text : text.slice(0, sep);
  const message = sep < 0 ? '' : text.slice(sep + 2);
  let object = '';
  let type: ObjType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjType;
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildTag(fields: { object: string; type: ObjType; tag: string; tagger: string; message: string }): Buffer {
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${fields.tagger}\n\n${fields.message}`,
    'utf8',
  );
}

// -------------------------------------------------------------------------------------------
// packfile
// -------------------------------------------------------------------------------------------

const PACK_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_IDS: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export interface PackRead {
  objects: Map<string, GitObject>;
  declaredCount: number;
  version: number;
  deltaCount: number;
}

function readPackVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    while (true) {
      const byte = delta[offset++]!;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) copyOffset |= delta[offset++]! << (8 * i);
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) copySize |= delta[offset++]! << (8 * i);
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      total += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      total += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (total !== targetSize) throw new Error('delta target size mismatch');
  return Buffer.concat(out);
}

/** Read a v2/v3 pack. Resolves OFS_DELTA/REF_DELTA against objects in the same pack. */
export function readPack(buffer: Buffer): PackRead {
  if (buffer.length < 12 || buffer.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buffer.readUInt32BE(4);
  const declaredCount = buffer.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let deltaCount = 0;
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const first = buffer[offset]!;
    const typeId = (first >> 4) & 0x7;
    const { size, next } = readPackVarint(buffer, offset);
    offset = next;
    let base: GitObject | undefined;
    let baseOid = '';
    if (typeId === 6) {
      // OFS_DELTA: base offset encoded as a negative offset varint.
      let byte = buffer[offset++]!;
      let baseOffset = byte & 0x7f;
      while (byte & 0x80) {
        byte = buffer[offset++]!;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      const target = entryOffset - baseOffset;
      base = byOffset.get(target);
      if (!base) throw new Error('ofs-delta base not in pack');
      deltaCount += 1;
    } else if (typeId === 7) {
      baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      base = objects.get(baseOid) ?? byOffset.get(0);
      if (!base) throw new Error('ref-delta base not in pack');
      deltaCount += 1;
    }
    // Inflate one zlib stream at `offset`; {info:true} reports the bytes consumed.
    const inflatedResult = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    const inflated = inflatedResult.buffer;
    const consumed = inflatedResult.engine.bytesWritten;
    if (!consumed || consumed <= 0) throw new Error('zlib stream consumed no bytes');
    offset += consumed;
    let object: GitObject;
    if (typeId === 6 || typeId === 7) {
      const resolved = applyDelta(base!.data, inflated);
      object = { type: base!.type, data: resolved };
    } else {
      const type = PACK_TYPES[typeId];
      if (!type) throw new Error(`unknown pack object type ${typeId}`);
      if (inflated.length !== size) throw new Error('pack object size mismatch');
      object = { type, data: inflated };
    }
    const oid = hashObject(object.type, object.data);
    objects.set(oid, object);
    byOffset.set(entryOffset, object);
  }
  return { objects, declaredCount, version, deltaCount };
}

export function packChecksum(pack: Buffer): string {
  return sha1Hex(pack.subarray(0, pack.length - 20));
}

export function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 32) return false;
  return packChecksum(pack) === pack.subarray(pack.length - 20).toString('hex');
}

/** Write a v2 pack of plain objects (no deltas), in the order given. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [head];
  for (const object of list) {
    const typeId = PACK_TYPE_IDS[object.type];
    const size = object.data.length;
    const headerBytes: number[] = [];
    let remaining = size;
    let firstByte = (typeId << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) firstByte |= 0x80;
    headerBytes.push(firstByte);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

// -------------------------------------------------------------------------------------------
// reachability
// -------------------------------------------------------------------------------------------

export type ObjectLookup = (oid: string) => GitObject | undefined;

/** All ancestors of `tips` (inclusive), following commit parents and tag targets. */
export function collectAncestors(lookup: ObjectLookup, tips: Iterable<string>, stopAt?: Set<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    // A shallow boundary is held but its parents are not: stop the walk here.
    if (stopAt?.has(oid)) continue;
    if (object.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** True when `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(lookup: ObjectLookup, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return collectAncestors(lookup, [descendant]).has(ancestor);
}

/** The nearest common ancestor of `a` and `b` (first found walking `b` by distance). */
export function mergeBase(lookup: ObjectLookup, a: string, b: string): string | null {
  const aAncestors = collectAncestors(lookup, [a]);
  const queue: string[] = [b];
  const seen = new Set<string>([b]);
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (aAncestors.has(oid)) return oid;
    const object = lookup(oid);
    if (!object) continue;
    if (object.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) {
        if (!seen.has(parent)) {
          seen.add(parent);
          queue.push(parent);
        }
      }
    } else if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return null;
}

/** The full closure of a commit: the commit, its trees and blobs, recursively. */
export function closureObjects(lookup: ObjectLookup, tips: Iterable<string>, stopAt?: Set<string>): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const ancestors = collectAncestors(lookup, tips, stopAt);
  const walkTree = (treeOid: string): void => {
    const tree = lookup(treeOid);
    if (!tree || tree.type !== 'tree' || out.has(treeOid)) return;
    out.set(treeOid, tree);
    for (const entry of parseTree(tree.data)) {
      const child = lookup(entry.oid);
      if (!child) continue;
      if (child.type === 'tree') walkTree(entry.oid);
      else if (!out.has(entry.oid)) out.set(entry.oid, child);
    }
  };
  for (const oid of ancestors) {
    const object = lookup(oid);
    if (!object) continue;
    out.set(oid, object);
    if (object.type === 'commit') walkTree(parseCommit(object.data).tree);
    else if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = lookup(target);
      if (targetObject?.type === 'commit') walkTree(parseCommit(targetObject.data).tree);
    }
  }
  return out;
}

/** The closure of exactly the given objects: each tip plus its own tree (and,
// for an annotated tag, its target commit plus that commit's tree) — but NOT
// the tips' ancestors. A depth-limited fetch sends exactly this set. */
export function closureOfExact(lookup: ObjectLookup, tips: Iterable<string>): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const walkTree = (treeOid: string): void => {
    const tree = lookup(treeOid);
    if (!tree || tree.type !== 'tree' || out.has(treeOid)) return;
    out.set(treeOid, tree);
    for (const entry of parseTree(tree.data)) {
      const child = lookup(entry.oid);
      if (!child) continue;
      if (child.type === 'tree') walkTree(entry.oid);
      else if (!out.has(entry.oid)) out.set(entry.oid, child);
    }
  };
  for (const oid of tips) {
    const object = lookup(oid);
    if (!object) continue;
    out.set(oid, object);
    if (object.type === 'commit') walkTree(parseCommit(object.data).tree);
    else if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = lookup(target);
      if (targetObject?.type === 'commit') {
        out.set(target, targetObject);
        walkTree(parseCommit(targetObject.data).tree);
      }
    }
  }
  return out;
}
