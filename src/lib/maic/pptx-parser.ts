import { inflateRawSync } from 'node:zlib';
import type { PPTAnimation, SlidePage } from './types';
import { buildDefaultSlideAnimations } from './slide-animation';

export interface ParsedPptxSlides {
  filename: string;
  pages: SlidePage[];
  raw_text: string;
}

interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const EOCD_SEARCH_WINDOW = 0xffff + EOCD_MIN_SIZE;
const DEFAULT_PPTX_ANIMATION_DURATION = 650;

export function parsePptxSlides(buffer: Buffer, filename: string): ParsedPptxSlides {
  const entries = readZipEntries(buffer);
  const slideFiles = Array.from(entries.keys())
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  if (slideFiles.length === 0) {
    throw new Error('PPTX 中未找到 slide XML');
  }

  const pages: SlidePage[] = slideFiles.map((slideFile, index) => {
    const xml = entries.get(slideFile)?.toString('utf-8') ?? '';
    const rawText = extractSlideText(xml) || `第 ${index + 1} 页`;
    const explicitAnimations = extractPptxAnimationsFromSlideXml(xml, index);
    const animations =
      explicitAnimations.length > 0
        ? explicitAnimations
        : buildDefaultSlideAnimations(index, estimatePointCount(rawText));

    return {
      index,
      raw_text: rawText,
      description: '',
      key_points: [],
      animations,
      turning_mode: 'fade',
    };
  });

  return {
    filename,
    pages,
    raw_text: pages.map(page => page.raw_text).join('\f'),
  };
}

export function extractPptxAnimationsFromSlideXml(
  slideXml: string,
  slideIndex: number
): PPTAnimation[] {
  const timing = slideXml.match(/<p:timing[\s\S]*?<\/p:timing>/i)?.[0];
  if (!timing) return [];

  const animations: PPTAnimation[] = [];
  const animationPattern =
    /<p:(animEffect|animMotion|animScale|animRot|set|cmd)\b[\s\S]*?<\/p:\1>/gi;
  let match: RegExpExecArray | null;

  while ((match = animationPattern.exec(timing)) !== null) {
    const segment = match[0];
    const context = timing.slice(Math.max(0, match.index - 500), animationPattern.lastIndex);
    const tag = match[1];
    const spid = readXmlAttribute(segment, 'spid') ?? String(animations.length + 1);
    const duration = parseDuration(readXmlAttribute(segment, 'dur'));
    animations.push({
      id: `pptx_anim_${slideIndex}_${animations.length}`,
      elId: `pptx-sp-${spid}`,
      effect: inferAnimationEffect(tag, segment),
      type: inferAnimationType(segment),
      duration,
      trigger: inferAnimationTrigger(context),
    });
  }

  return animations;
}

function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = new Map<string, Buffer>();

  let cursor = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_SIGNATURE) break;

    const entry: ZipEntry = {
      compressionMethod: buffer.readUInt16LE(cursor + 10),
      compressedSize: buffer.readUInt32LE(cursor + 20),
      localHeaderOffset: buffer.readUInt32LE(cursor + 42),
      name: '',
    };
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    entry.name = buffer.subarray(cursor + 46, cursor + 46 + fileNameLength).toString('utf-8');

    const data = readZipEntryData(buffer, entry);
    entries.set(entry.name, data);

    cursor += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const start = Math.max(0, buffer.length - EOCD_SEARCH_WINDOW);
  for (let offset = buffer.length - EOCD_MIN_SIZE; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error('无效 PPTX: 未找到 ZIP 中央目录');
}

function readZipEntryData(buffer: Buffer, entry: ZipEntry): Buffer {
  const localOffset = entry.localHeaderOffset;
  if (buffer.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error(`无效 PPTX: 本地文件头损坏 ${entry.name}`);
  }
  const fileNameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + fileNameLength + extraLength;
  const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.compressionMethod === 0) return compressed;
  if (entry.compressionMethod === 8) return inflateRawSync(compressed);
  throw new Error(`不支持的 PPTX 压缩方式: ${entry.compressionMethod}`);
}

function slideNumber(path: string): number {
  return Number(path.match(/slide(\d+)\.xml$/i)?.[1] ?? 0);
}

function extractSlideText(xml: string): string {
  const texts = Array.from(xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/gi))
    .map(match => decodeXml(match[1]).trim())
    .filter(Boolean);
  return texts.join('\n');
}

function readXmlAttribute(xml: string, attribute: string): string | undefined {
  return xml.match(new RegExp(`\\b${attribute}="([^"]+)"`, 'i'))?.[1];
}

function inferAnimationEffect(tag: string, xml: string): string {
  const effect =
    readXmlAttribute(xml, 'filter') ??
    readXmlAttribute(xml, 'cmd') ??
    readXmlAttribute(xml, 'calcmode') ??
    tag.replace(/^anim/i, '').toLowerCase();
  return effect || 'fade';
}

function inferAnimationType(xml: string): PPTAnimation['type'] {
  const transition = readXmlAttribute(xml, 'transition');
  if (transition === 'in' || transition === 'out') return transition;
  return 'attention';
}

function inferAnimationTrigger(xml: string): PPTAnimation['trigger'] {
  const nodeType = readXmlAttribute(xml, 'nodeType')?.toLowerCase();
  if (nodeType?.includes('click')) return 'click';
  if (nodeType?.includes('with')) return 'meantime';
  return 'auto';
}

function parseDuration(duration: string | undefined): number {
  if (!duration || duration === 'indefinite') return DEFAULT_PPTX_ANIMATION_DURATION;
  const parsed = Number(duration);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PPTX_ANIMATION_DURATION;
}

function estimatePointCount(text: string): number {
  return Math.max(1, Math.min(4, text.split(/\n+/).filter(Boolean).length - 1));
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}
