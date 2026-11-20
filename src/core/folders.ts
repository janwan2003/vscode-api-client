/**
 * The Collections tree: workspace-relative `.http` paths grouped into their folders, the way the
 * Explorer shows them. A folder whose only child is one folder is shown as one row (`api/v2`),
 * like VS Code's compact folders. Pure, so it can be tested without VS Code.
 */

export interface FolderNode {
  /** Shown label: one segment, or several joined with '/' when compacted. */
  label: string;
  /** Path relative to the root, '/'-separated ('' for the root). */
  path: string;
  folders: FolderNode[];
  /** Relative paths of the files directly in this folder, sorted. */
  files: string[];
}

export function buildFolderTree(paths: string[], compact = true): FolderNode {
  const root: FolderNode = { label: '', path: '', folders: [], files: [] };
  for (const p of paths) {
    const parts = p.split('/').filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/');
      let next = node.folders.find((f) => f.path === path);
      if (!next) {
        next = { label: parts[i], path, folders: [], files: [] };
        node.folders.push(next);
      }
      node = next;
    }
    if (parts.length) node.files.push(parts.join('/'));
  }
  const finish = (n: FolderNode): FolderNode => {
    n.folders = n.folders.map(finish);
    if (compact && n.path !== '') {
      while (n.files.length === 0 && n.folders.length === 1) {
        const only = n.folders[0];
        n = { label: `${n.label}/${only.label}`, path: only.path, folders: only.folders, files: only.files };
      }
    }
    n.folders.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true }));
    n.files.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
    return n;
  };
  return finish(root);
}

/** Find the node for a folder path ('' = root). */
export function findFolder(root: FolderNode, path: string): FolderNode | undefined {
  if (root.path === path) return root;
  for (const f of root.folders) {
    if (path === f.path || path.startsWith(f.path + '/')) {
      const hit = findFolder(f, path);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** File and folder names that cannot exist on Windows or would escape the folder. */
export function invalidName(name: string): string | undefined {
  const n = name.trim();
  if (!n) return 'Enter a name.';
  if (/[\\/:*?"<>|]/.test(n)) return 'A name cannot contain \\ / : * ? " < > |';
  if (n === '.' || n === '..' || /[.\s]$/.test(n)) return 'A name cannot end with a dot or a space.';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) return `"${n}" is a reserved name on Windows.`;
  return undefined;
}

/** The folder that directly contains folder `path` or file `path` (undefined for top-level entries). */
export function parentFolder(root: FolderNode, path: string): FolderNode | undefined {
  const walk = (n: FolderNode): FolderNode | undefined => {
    if (n.files.includes(path) || n.folders.some((f) => f.path === path)) return n;
    for (const f of n.folders) if (path.startsWith(f.path + '/')) return walk(f);
    return undefined;
  };
  const hit = walk(root);
  return hit === root ? undefined : hit;
}
