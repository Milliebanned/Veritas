import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { resolveInside } from './paths.ts';

export class EditRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditRejected';
  }
}

const TEST_PATH = /(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const NEVER = /(^|\/)(node_modules|\.git)\/|(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/;

export const isTestFile = (path: string) => TEST_PATH.test(path);

export interface EditRequest {
  file: string;
  oldText: string;
  newText: string;
  /** Tests define what "fixed" means, so they change only when the repair plan gave a reason. */
  allowTests?: boolean;
}

/**
 * The only way the model changes code: replace one exact, unique piece of text in one file
 * inside the workspace. Lockfiles and installed packages are changed by npm, never by an edit.
 */
export function applyEdit(root: string, edit: EditRequest): { file: string; linesBefore: number; linesAfter: number } {
  const path = resolveInside(root, edit.file);
  const file = relative(resolveInside(root, '.'), path);
  if (NEVER.test(file)) throw new EditRejected(`${file} cannot be edited. Dependency versions are changed by the upgrade step, not by edits.`);
  if (isTestFile(file) && !edit.allowTests) {
    throw new EditRejected(`${file} is a test file. Fix the code under test. A test may change only when the upgrade changes documented behaviour that the test asserts, and the plan says so.`);
  }
  if (!existsSync(path)) throw new EditRejected(`${file} does not exist.`);
  if (edit.oldText === edit.newText) throw new EditRejected('old_text and new_text are identical.');
  if (!edit.oldText) throw new EditRejected('old_text is empty.');

  const before = readFileSync(path, 'utf8');
  let occurrences = before.split(edit.oldText).length - 1;

  if (occurrences === 0) {
    const beforeLines = before.split('\n');
    const oldLines = edit.oldText.split('\n');
    const matchIndices: number[] = [];

    for (let i = 0; i <= beforeLines.length - oldLines.length; i++) {
      let match = true;
      for (let j = 0; j < oldLines.length; j++) {
        if (beforeLines[i + j].replace(/^[ \t]*/, '') !== oldLines[j].replace(/^[ \t]*/, '')) {
          match = false;
          break;
        } 
      }
      if (match) {
        matchIndices.push(i);
      }
    }

    if (matchIndices.length === 0) {
      throw new EditRejected(`old_text was not found in ${file}. Read the file again and copy the text exactly, including whitespace.`);
    }
    if (matchIndices.length > 1) {
      throw new EditRejected(`old_text appears ${matchIndices.length} times in ${file}. Include more surrounding lines so it matches once.`);
    }

    const startIdx = matchIndices[0];
    const getLeadingWhitespace = (line: string) => {
      const m = line.match(/^[ \t]*/);
      return m ? m[0] : '';
    };

    const fileIndent = getLeadingWhitespace(beforeLines[startIdx]);
    const oldIndent = getLeadingWhitespace(oldLines[0]);

    const newLines = edit.newText.split('\n');
    let adjustedNewLines: string[];

    if (fileIndent.length > oldIndent.length) {
      const toAdd = fileIndent.slice(oldIndent.length);
      adjustedNewLines = newLines.map(line => {
        return line.trim() === '' ? '' : toAdd + line;
      });
    } else if (fileIndent.length < oldIndent.length) {
      const toRemove = oldIndent.slice(fileIndent.length);
      adjustedNewLines = newLines.map(line => {
        if (line.startsWith(toRemove)) {
          return line.slice(toRemove.length);
        }
        const leading = getLeadingWhitespace(line);
        const removeCount = Math.min(leading.length, toRemove.length);
        return line.slice(removeCount);
      });
    } else {
      adjustedNewLines = newLines;
    }

    beforeLines.splice(startIdx, oldLines.length, ...adjustedNewLines);
    const after = beforeLines.join('\n');
    writeFileSync(path, after);
    return { file, linesBefore: before.split('\n').length, linesAfter: after.split('\n').length };
  }

  if (occurrences > 1) throw new EditRejected(`old_text appears ${occurrences} times in ${file}. Include more surrounding lines so it matches once.`);

  const after = before.replace(edit.oldText, () => edit.newText);
  writeFileSync(path, after);
  return { file, linesBefore: before.split('\n').length, linesAfter: after.split('\n').length };
}
