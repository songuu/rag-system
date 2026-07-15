import { inflateRawSync } from 'node:zlib';

export interface ZipSafetyLimits {
  maxEntries?: number;
  maxTotalUncompressedBytes?: number;
  maxEntryUncompressedBytes?: number;
  maxCompressionRatio?: number;
}

const ZIP_SIGNATURES = {
  localFile: 0x04034b50,
  centralFile: 0x02014b50,
  endOfCentralDirectory: 0x06054b50,
} as const;

const DEFAULT_LIMITS = {
  maxEntries: 2_000,
  maxTotalUncompressedBytes: 32 * 1024 * 1024,
  maxEntryUncompressedBytes: 16 * 1024 * 1024,
  maxCompressionRatio: 100,
} as const;

/**
 * Validates the central directory before OOXML parsers allocate decompressed
 * entries. ZIP64, multi-disk, encrypted, exotic compression, and ambiguous
 * directory layouts are rejected because they cannot be bounded by this seam.
 */
export function assertSafeZipArchive(
  buffer: Buffer,
  limits: ZipSafetyLimits = {}
): void {
  const resolved = { ...DEFAULT_LIMITS, ...limits };
  assertPositiveInteger(resolved.maxEntries, 'maxEntries');
  assertPositiveInteger(resolved.maxTotalUncompressedBytes, 'maxTotalUncompressedBytes');
  assertPositiveInteger(resolved.maxEntryUncompressedBytes, 'maxEntryUncompressedBytes');
  if (!Number.isFinite(resolved.maxCompressionRatio) || resolved.maxCompressionRatio <= 0) {
    throw new Error('maxCompressionRatio must be a positive finite number.');
  }
  if (
    buffer.length < 22
    || buffer.readUInt32LE(0) !== ZIP_SIGNATURES.localFile
  ) {
    throw new Error('File is not a supported ZIP container.');
  }

  const eocdOffset = findEndOfCentralDirectory(buffer);
  const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
  const centralDirectoryDisk = buffer.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocdOffset + 8);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const commentLength = buffer.readUInt16LE(eocdOffset + 20);

  if (eocdOffset + 22 + commentLength !== buffer.length) {
    throw new Error('ZIP end record is ambiguous or contains trailing data.');
  }
  if (
    diskNumber !== 0
    || centralDirectoryDisk !== 0
    || entriesOnDisk !== totalEntries
  ) {
    throw new Error('Multi-disk ZIP archives are not supported.');
  }
  if (
    totalEntries === 0xffff
    || centralDirectorySize === 0xffffffff
    || centralDirectoryOffset === 0xffffffff
  ) {
    throw new Error('ZIP64 archives are not supported.');
  }
  if (totalEntries === 0 || totalEntries > resolved.maxEntries) {
    throw new Error(`ZIP entry count exceeds the limit of ${resolved.maxEntries}.`);
  }

  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  if (
    !Number.isSafeInteger(centralDirectoryEnd)
    || centralDirectoryOffset < 4
    || centralDirectoryEnd !== eocdOffset
    || centralDirectoryEnd > buffer.length
  ) {
    throw new Error('ZIP central directory is malformed.');
  }

  let offset = centralDirectoryOffset;
  let totalUncompressedBytes = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (
      offset + 46 > centralDirectoryEnd
      || buffer.readUInt32LE(offset) !== ZIP_SIGNATURES.centralFile
    ) {
      throw new Error('ZIP central directory entry is malformed.');
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedBytes = buffer.readUInt32LE(offset + 20);
    const uncompressedBytes = buffer.readUInt32LE(offset + 24);
    const filenameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const entryCommentLength = buffer.readUInt16LE(offset + 32);
    const diskStart = buffer.readUInt16LE(offset + 34);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + filenameLength + extraLength + entryCommentLength;

    if ((flags & 0x1) !== 0) {
      throw new Error('Encrypted ZIP entries are not supported.');
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new Error('ZIP entry uses an unsupported compression method.');
    }
    if (
      compressedBytes === 0xffffffff
      || uncompressedBytes === 0xffffffff
      || localHeaderOffset === 0xffffffff
      || diskStart !== 0
    ) {
      throw new Error('ZIP64 or multi-disk entries are not supported.');
    }
    if (uncompressedBytes > resolved.maxEntryUncompressedBytes) {
      throw new Error('ZIP entry exceeds the uncompressed size limit.');
    }
    if (
      uncompressedBytes > 0
      && uncompressedBytes / Math.max(1, compressedBytes) > resolved.maxCompressionRatio
    ) {
      throw new Error('ZIP entry exceeds the compression ratio limit.');
    }
    totalUncompressedBytes += uncompressedBytes;
    if (totalUncompressedBytes > resolved.maxTotalUncompressedBytes) {
      throw new Error('ZIP archive exceeds the total uncompressed size limit.');
    }
    if (nextOffset > centralDirectoryEnd) {
      throw new Error('ZIP central directory entry exceeds its declared bounds.');
    }
    const filename = buffer.subarray(offset + 46, offset + 46 + filenameLength);
    validateEntryPayload(buffer, {
      flags,
      compressionMethod,
      compressedBytes,
      uncompressedBytes,
      localHeaderOffset,
      filename,
    }, centralDirectoryOffset, resolved.maxEntryUncompressedBytes);
    offset = nextOffset;
  }
  if (offset !== centralDirectoryEnd) {
    throw new Error('ZIP central directory contains unparsed data.');
  }
}

interface ZipEntryPayload {
  flags: number;
  compressionMethod: number;
  compressedBytes: number;
  uncompressedBytes: number;
  localHeaderOffset: number;
  filename: Buffer;
}

function validateEntryPayload(
  buffer: Buffer,
  entry: ZipEntryPayload,
  centralDirectoryOffset: number,
  maxEntryUncompressedBytes: number
): void {
  const localOffset = entry.localHeaderOffset;
  if (
    localOffset + 30 > centralDirectoryOffset
    || buffer.readUInt32LE(localOffset) !== ZIP_SIGNATURES.localFile
  ) {
    throw new Error('ZIP local file header is malformed.');
  }

  const localFlags = buffer.readUInt16LE(localOffset + 6);
  const localCompressionMethod = buffer.readUInt16LE(localOffset + 8);
  const localCompressedBytes = buffer.readUInt32LE(localOffset + 18);
  const localUncompressedBytes = buffer.readUInt32LE(localOffset + 22);
  const localFilenameLength = buffer.readUInt16LE(localOffset + 26);
  const localExtraLength = buffer.readUInt16LE(localOffset + 28);
  const localFilenameStart = localOffset + 30;
  const dataStart = localFilenameStart + localFilenameLength + localExtraLength;
  const dataEnd = dataStart + entry.compressedBytes;

  if (
    localCompressionMethod !== entry.compressionMethod
    || (localFlags & 0x9) !== (entry.flags & 0x9)
  ) {
    throw new Error('ZIP local and central headers disagree.');
  }
  if (
    dataStart > centralDirectoryOffset
    || !Number.isSafeInteger(dataEnd)
    || dataEnd > centralDirectoryOffset
    || dataEnd > buffer.length
  ) {
    throw new Error('ZIP entry payload exceeds its declared bounds.');
  }
  const localFilename = buffer.subarray(
    localFilenameStart,
    localFilenameStart + localFilenameLength
  );
  if (!localFilename.equals(entry.filename)) {
    throw new Error('ZIP local and central filenames disagree.');
  }

  const usesDataDescriptor = (entry.flags & 0x8) !== 0;
  if (
    !usesDataDescriptor
    && (
      localCompressedBytes !== entry.compressedBytes
      || localUncompressedBytes !== entry.uncompressedBytes
    )
  ) {
    throw new Error('ZIP local and central sizes disagree.');
  }

  const compressed = buffer.subarray(dataStart, dataEnd);
  if (entry.compressionMethod === 0) {
    if (
      entry.compressedBytes !== entry.uncompressedBytes
      || compressed.length !== entry.uncompressedBytes
    ) {
      throw new Error('Stored ZIP entry size is inconsistent.');
    }
    return;
  }

  let actualUncompressedBytes: number;
  try {
    const maxOutputLength = Math.max(
      1,
      Math.min(maxEntryUncompressedBytes + 1, entry.uncompressedBytes + 1)
    );
    actualUncompressedBytes = inflateRawSync(compressed, { maxOutputLength }).length;
  } catch {
    throw new Error('ZIP entry decompressed output exceeds its declared limit or is invalid.');
  }
  if (actualUncompressedBytes !== entry.uncompressedBytes) {
    throw new Error('ZIP entry decompressed size does not match its declaration.');
  }
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimumOffset = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_SIGNATURES.endOfCentralDirectory) {
      return offset;
    }
  }
  throw new Error('ZIP end record is missing.');
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
}
