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
  const occurrences = before.split(edit.oldText).length - 1;
  if (occurrences === 0) throw new EditRejected(`old_text was not found in ${file}. Read the file again and copy the text exactly, including whitespace.`);
  if (occurrences > 1) throw new EditRejected(`old_text appears ${occurrences} times in ${file}. Include more surrounding lines so it matches once.`);

  const after = before.replace(edit.oldText, () => edit.newText);
  writeFileSync(path, after);
  return { file, linesBefore: before.split('\n').length, linesAfter: after.split('\n').length };
}
