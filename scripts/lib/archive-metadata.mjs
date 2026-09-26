/**
 * Archive metadata privacy checks. Release archives must not carry the builder's account
 * (tar uname/gname/uid/gid) or extended attributes (macOS provenance/quarantine xattrs).
 * The parsers read raw headers so the check does not depend on the tar/zip flavor that built them.
 */
import { gunzipSync } from 'node:zlib';

/** @param {Buffer} block @param {number} offset @param {number} length */
function field(block, offset, length) {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}
/** @param {string} text */
function octal(text) {
  const trimmed = text.replace(/[\0 ]+$/g, '').trim();
  return trimmed === '' ? 0 : Number.parseInt(trimmed, 8);
}
/** @param {Buffer} data */
function paxKeys(data) {
  const keys = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(offset, space).toString('ascii'), 10);
    if (!Number.isSafeInteger(length) || length <= 0) break;
    const record = data.subarray(space + 1, offset + length).toString('utf8');
    const equals = record.indexOf('=');
    if (equals > 0) keys.push(record.slice(0, equals));
    offset += length;
  }
  return keys;
}

/**
 * @param {Buffer} gzipped
 * @returns {string[]} one finding per offending entry
 */
export function tarMetadataFindings(gzipped) {
  const tar = gunzipSync(gzipped);
  const findings = [];
  let offset = 0;
  let pendingPax = [];
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = field(header, 0, 100);
    const size = octal(field(header, 124, 12));
    const type = String.fromCharCode(header[156] || 0x30);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x' || type === 'g') { pendingPax.push(...paxKeys(body)); continue; }
    if (type === 'L' || type === 'K') continue;
    const problems = [];
    const uid = octal(field(header, 108, 8)); const gid = octal(field(header, 116, 8));
    const uname = field(header, 265, 32); const gname = field(header, 297, 32);
    if (uid !== 0 || gid !== 0) problems.push('uid/gid ' + uid + '/' + gid);
    if (uname !== '' && uname !== 'root') problems.push('uname ' + JSON.stringify(uname));
    if (gname !== '' && gname !== 'root' && gname !== 'wheel') problems.push('gname ' + JSON.stringify(gname));
    const extended = pendingPax.filter((key) => /xattr|acl|fflags|LIBARCHIVE\.|SCHILY\.(?!devminor|devmajor)/i.test(key) || key === 'uname' || key === 'gname' || key === 'uid' || key === 'gid');
    if (extended.length) problems.push('pax ' + [...new Set(extended)].join(','));
    pendingPax = [];
    if (problems.length) findings.push(name + ': ' + problems.join('; '));
  }
  return findings;
}

/**
 * Zip central-directory check: no Unix uid/gid extra fields (0x7875 "ux", 0x7855 "Ux")
 * and no AppleDouble/__MACOSX members.
 * @param {Buffer} zip
 * @returns {string[]}
 */
export function zipMetadataFindings(zip) {
  const findings = [];
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd === -1) return ['zip: end of central directory not found'];
  const entries = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  for (let index = 0; index < entries; index += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) return [...findings, 'zip: malformed central directory'];
    const nameLength = zip.readUInt16LE(offset + 28); const extraLength = zip.readUInt16LE(offset + 30); const commentLength = zip.readUInt16LE(offset + 32);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const extra = zip.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength);
    const problems = [];
    for (let cursor = 0; cursor + 4 <= extra.length;) {
      const id = extra.readUInt16LE(cursor); const length = extra.readUInt16LE(cursor + 2);
      if (id === 0x7875 || id === 0x7855) problems.push('unix owner extra field 0x' + id.toString(16));
      cursor += 4 + length;
    }
    if (name.split('/').some((part) => part === '__MACOSX' || part.startsWith('._') || part === '.DS_Store')) problems.push('macOS metadata member');
    if (problems.length) findings.push(name + ': ' + problems.join('; '));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return findings;
}

/** @param {string} versionOutput */
export function tarFlavor(versionOutput) {
  if (/bsdtar/i.test(versionOutput)) return 'bsd';
  if (/GNU tar/i.test(versionOutput)) return 'gnu';
  return 'unknown';
}

/** Normalizing create flags per tar flavor (placed before -C/members). */
export function normalizedTarFlags(flavor) {
  if (flavor === 'bsd') return ['--uid', '0', '--gid', '0', '--uname', '', '--gname', '', '--no-xattrs', '--no-mac-metadata', '--no-acls', '--no-fflags'];
  if (flavor === 'gnu') return ['--owner=0', '--group=0', '--numeric-owner', '--no-xattrs', '--no-acls', '--sort=name'];
  throw new Error('unsupported tar implementation; cannot normalize archive metadata');
}
