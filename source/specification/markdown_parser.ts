/**
 * Lightweight Markdown parser for Software Factory specifications.
 *
 * Supported block syntax:
 * - ATX headings (# through ######)
 * - paragraphs
 * - unordered and ordered lists (including nested list indentation)
 * - fenced code blocks (``` or ~~~)
 * - blockquotes
 * - horizontal rules
 * - GitHub-style tables
 *
 * This is intentionally a spec-oriented parser, not a complete CommonMark
 * implementation. It has no runtime dependencies.
 */

export type MarkdownListItem = {
  text: string;
  depth: number;
  ordered: boolean;
  order?: number;
};

export type MarkdownBlock =
  | { type: 'heading'; depth: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: MarkdownListItem[] }
  | { type: 'code'; language: string; value: string }
  | { type: 'blockquote'; text: string }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'hr' };

export type MarkdownSection = {
  heading: string;
  depth: number;
  content: string[];
};

export type ProjectSpecification = {
  title: string;
  description: string;
  requirements: string[];
  acceptanceCriteria: string[];
  constraints: string[];
  techStack: string[];
  sections: MarkdownSection[];
  blocks: MarkdownBlock[];
  rawMarkdown: string;
};

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const UNORDERED_RE = /^([-*+])\s+(.+)$/;
const ORDERED_RE = /^(\d+)[.)]\s+(.+)$/;
const FENCE_RE = /^\s*(```+|~~~+)\s*([^\s]*)?.*$/;
const HR_RE = /^\s*(?:([-*_])\s*){3,}$/;

function cleanInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<https?:\/\/[^>]+>/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .trim();
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(trimmed);
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cleanInlineMarkdown(cell.trim()));
}

function getListMatch(line: string):
  | { ordered: boolean; text: string; order?: number; indent: number }
  | undefined {
  const indent = line.length - line.trimStart().length;
  const content = line.trimStart();
  const unordered = content.match(UNORDERED_RE);

  if (unordered) {
    return { ordered: false, text: unordered[2]!, indent };
  }

  const ordered = content.match(ORDERED_RE);

  if (ordered) {
    return {
      ordered: true,
      text: ordered[2]!,
      order: Number(ordered[1]),
      indent,
    };
  }

  return undefined;
}

export function parseMarkdown(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    const fence = line.match(FENCE_RE);
    if (fence) {
      const marker = fence[1]!;
      const language = fence[2] ?? '';
      const codeLines: string[] = [];
      index += 1;

      while (index < lines.length && !lines[index]!.trimStart().startsWith(marker)) {
        codeLines.push(lines[index]!);
        index += 1;
      }

      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', language, value: codeLines.join('\n') });
      continue;
    }

    const heading = trimmed.match(HEADING_RE);
    if (heading) {
      blocks.push({
        type: 'heading',
        depth: heading[1]!.length,
        text: cleanInlineMarkdown(heading[2]!),
      });
      index += 1;
      continue;
    }

    if (HR_RE.test(trimmed)) {
      blocks.push({ type: 'hr' });
      index += 1;
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (index < lines.length && lines[index]!.trimStart().startsWith('>')) {
        quoteLines.push(lines[index]!.trimStart().replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push({
        type: 'blockquote',
        text: cleanInlineMarkdown(quoteLines.join(' ')),
      });
      continue;
    }

    if (
      index + 1 < lines.length &&
      line.includes('|') &&
      isTableSeparator(lines[index + 1]!)
    ) {
      const headers = splitTableRow(line);
      index += 2;
      const rows: string[][] = [];

      while (index < lines.length && lines[index]!.includes('|') && lines[index]!.trim()) {
        rows.push(splitTableRow(lines[index]!));
        index += 1;
      }

      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    const firstListItem = getListMatch(line);
    if (firstListItem) {
      const items: MarkdownListItem[] = [];
      const ordered = firstListItem.ordered;

      while (index < lines.length) {
        const current = lines[index]!;
        const match = getListMatch(current);

        if (match) {
          items.push({
            text: cleanInlineMarkdown(match.text),
            depth: Math.floor(match.indent / 2),
            ordered: match.ordered,
            ...(match.order === undefined ? {} : { order: match.order }),
          });
          index += 1;
          continue;
        }

        // A blank line can occur between items; keep consuming only when
        // the next non-empty line is another list item.
        if (!current.trim()) {
          let lookahead = index + 1;
          while (lookahead < lines.length && !lines[lookahead]!.trim()) lookahead += 1;
          if (lookahead < lines.length && getListMatch(lines[lookahead]!)) {
            index = lookahead;
            continue;
          }
        }

        break;
      }

      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const paragraphLines: string[] = [cleanInlineMarkdown(trimmed)];
    index += 1;

    while (index < lines.length) {
      const next = lines[index]!;
      const nextTrimmed = next.trim();

      if (
        !nextTrimmed ||
        HEADING_RE.test(nextTrimmed) ||
        FENCE_RE.test(next) ||
        HR_RE.test(nextTrimmed) ||
        nextTrimmed.startsWith('>') ||
        getListMatch(next) ||
        (index + 1 < lines.length && next.includes('|') && isTableSeparator(lines[index + 1]!))
      ) {
        break;
      }

      paragraphLines.push(cleanInlineMarkdown(nextTrimmed));
      index += 1;
    }

    blocks.push({ type: 'paragraph', text: paragraphLines.join(' ') });
  }

  return blocks;
}

function collectSections(blocks: MarkdownBlock[]): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  let current: MarkdownSection | undefined;

  for (const block of blocks) {
    if (block.type === 'heading') {
      current = {
        heading: block.text,
        depth: block.depth,
        content: [],
      };
      sections.push(current);
      continue;
    }

    if (!current) continue;

    if (block.type === 'paragraph') {
      current.content.push(block.text);
    } else if (block.type === 'list') {
      current.content.push(...block.items.map((item) => item.text));
    } else if (block.type === 'blockquote') {
      current.content.push(block.text);
    } else if (block.type === 'code') {
      current.content.push(block.value);
    } else if (block.type === 'table') {
      current.content.push(
        ...block.rows.map((row) =>
          block.headers.map((header, cellIndex) =>
            `${header}: ${row[cellIndex] ?? ''}`,
          ).join('; '),
        ),
      );
    }
  }

  return sections;
}

function matchesHeading(heading: string, terms: string[]): boolean {
  const normalized = heading.toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
  return terms.some((term) => normalized.includes(term));
}

function collectSectionContent(
  sections: MarkdownSection[],
  terms: string[],
): string[] {
  return sections
    .filter((section) => matchesHeading(section.heading, terms))
    .flatMap((section) => section.content)
    .filter(Boolean);
}


export function parseMarkdownSpecification(markdown: string): ProjectSpecification {
  if (!markdown.trim()) {
    throw new Error('The Markdown specification is empty.');
  }

  const blocks = parseMarkdown(markdown);
  const sections = collectSections(blocks);
  const firstHeading = blocks.find((block) => block.type === 'heading');
  const title = firstHeading?.type === 'heading' ? firstHeading.text : 'Untitled project';

  const description = collectSectionContent(sections, [
    'overview',
    'description',
    'project goal',
    'about',
    'summary',
  ]).join('\n') || blocks
    .filter((block) => block.type === 'paragraph')
    .slice(0, 2)
    .map((block) => block.type === 'paragraph' ? block.text : '')
    .join('\n');

  const requirements = collectSectionContent(sections, [
    'requirement',
    'functionalities',
    'features',
    'scope',
  ]);

  const acceptanceCriteria = collectSectionContent(sections, [
    'acceptance criteria',
    'definition of done',
    'success criteria',
    'tests',
  ]);

  const constraints = collectSectionContent(sections, [
    'constraint',
    'non functional',
    'limitations',
    'rules',
  ]);

  const techStack = collectSectionContent(sections, [
    'tech stack',
    'technology',
    'technologies',
    'technical requirements',
  ]);

  return {
    title,
    description,
    requirements,
    acceptanceCriteria,
    constraints,
    techStack,
    sections,
    blocks,
    rawMarkdown: markdown,
  };
}
