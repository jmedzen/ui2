import fs from 'node:fs';
import path from 'node:path';

/**
 * Returns the concatenated text of every stylesheet in `src/app`.
 *
 * The styles used to live in a single `globals.css`; it is now split into
 * `styles/base.css`, `themes.css`, `layout.css` and `components.css`, imported
 * in that order by `globals.css`. Tests that assert "this rule exists somewhere
 * in the stylesheet" should read the whole set rather than one file, so they
 * keep passing after the split and do not silently stop covering the parts that
 * moved.
 */
export function readAllStyles(): string {
  const stylesDir = path.join(process.cwd(), 'src', 'app', 'styles');
  const entry = path.join(process.cwd(), 'src', 'app', 'globals.css');

  const parts: string[] = [];
  if (fs.existsSync(entry)) parts.push(fs.readFileSync(entry, 'utf-8'));
  if (fs.existsSync(stylesDir)) {
    for (const file of fs.readdirSync(stylesDir).filter((f) => f.endsWith('.css')).sort()) {
      parts.push(fs.readFileSync(path.join(stylesDir, file), 'utf-8'));
    }
  }
  return parts.join('\n');
}
