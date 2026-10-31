import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import {
  parseMarkdownSpecification,
  type ProjectSpecification,
} from './markdown_parser.js';


export async function loadMarkdownSpecification(
  filePath: string,
): Promise<ProjectSpecification> {
  const extension = extname(filePath).toLowerCase();

  if (extension !== '.md' && extension !== '.markdown') {
    throw new Error(`Specification must be a Markdown file (.md or .markdown): ${filePath}`);
  }

  let markdown: string;

  try {
    markdown = await readFile(filePath, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read specification "${filePath}": ${detail}`);
  }

  try {
    return parseMarkdownSpecification(markdown);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid specification "${filePath}": ${detail}`);
  }
}
