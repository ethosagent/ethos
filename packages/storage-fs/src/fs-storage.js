import {
  appendFile,
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
export class FsStorage {
  async read(path) {
    try {
      return await readFile(path, 'utf-8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }
  async readBytes(path) {
    try {
      // No encoding → readFile returns a Buffer (which is a Uint8Array).
      return await readFile(path);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }
  async exists(path) {
    try {
      await stat(path);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  }
  async mtime(path) {
    try {
      const s = await stat(path);
      return s.mtimeMs;
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }
  async list(dir) {
    try {
      return await readdir(dir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }
  async listEntries(dir) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }
  async write(path, content, opts) {
    const isBinary = typeof content !== 'string';
    if (opts?.mode !== undefined) {
      await writeFile(
        path,
        content,
        isBinary ? { mode: opts.mode } : { encoding: 'utf-8', mode: opts.mode },
      );
      return;
    }
    await writeFile(path, content, isBinary ? undefined : 'utf-8');
  }
  async append(path, content) {
    // Asymmetry with InMemoryStorage.append: InMemoryStorage throws
    // EINVAL when appending to a binary node, but FsStorage cannot
    // detect that here without an extra stat + first-byte read. If the
    // file on disk is binary, this silently concatenates utf-8 bytes
    // and produces a malformed file. Callers writing binary content
    // must use writeAtomic, not append.
    await appendFile(path, content, 'utf-8');
  }
  async writeAtomic(path, content, opts) {
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    const isBinary = typeof content !== 'string';
    if (opts?.mode !== undefined) {
      await writeFile(
        tmp,
        content,
        isBinary ? { mode: opts.mode } : { encoding: 'utf-8', mode: opts.mode },
      );
    } else {
      await writeFile(tmp, content, isBinary ? undefined : 'utf-8');
    }
    try {
      await rename(tmp, path);
    } catch (err) {
      // Best-effort cleanup of temp file on rename failure.
      try {
        await rm(tmp, { force: true });
      } catch {
        // ignore
      }
      throw err;
    }
  }
  async mkdir(dir) {
    await mkdir(dir, { recursive: true });
  }
  async remove(path, opts) {
    await rm(path, { recursive: opts?.recursive === true });
  }
  async rename(from, to) {
    await rename(from, to);
  }
  async chmod(path, mode) {
    await chmod(path, mode);
  }
}
