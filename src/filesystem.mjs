import { fail, PHPWasmError } from './errors.mjs';
import { workspacePath } from './validation.mjs';

export class RuntimeFilesystem {
  constructor(module, maxBytes) {
    this.module = module;
    this.FS = module.FS;
    this.root = '/workspace';
    this.maxBytes = maxBytes;
    this.persistent = false;
    this.releaseLock = null;
  }

  async initialize(persistence) {
    if (!persistence) { this.FS.mkdirTree('/workspace'); return; }
    if (typeof indexedDB === 'undefined' || !globalThis.navigator?.locks || !this.module.IDBFS) {
      fail('PERSISTENCE_UNAVAILABLE', 'Safe persistence requires IndexedDB, Web Locks, and the IDBFS engine module');
    }
    let heldResolve;
    let acquiredResolve;
    let acquiredReject;
    const held = new Promise((resolve) => { heldResolve = resolve; });
    const acquired = new Promise((resolve, reject) => { acquiredResolve = resolve; acquiredReject = reject; });
    const lock = navigator.locks.request(`joomengine.php-wasm.${persistence.key}`, { mode: 'exclusive', ifAvailable: true }, async (handle) => {
      if (!handle) { acquiredReject(new PHPWasmError('PERSISTENCE_IN_USE', 'This persisted instance is already open in another runtime')); return; }
      this.releaseLock = heldResolve;
      acquiredResolve();
      await held;
    });
    lock.catch(acquiredReject);
    await acquired;
    // IDBFS names its database after its mountpoint: each key needs a distinct mountpoint.
    this.root = `/instances/${persistence.key}`;
    this.FS.mkdirTree(this.root);
    this.FS.mount(this.module.IDBFS, {}, this.root);
    this.FS.symlink(this.root, '/workspace');
    this.persistent = true;
    await this.sync(true);
  }

  async sync(populate = false) {
    if (!this.persistent) return;
    await new Promise((resolve, reject) => this.FS.syncfs(populate, (error) => {
      if (error) reject(new PHPWasmError('PERSISTENCE_FAILED', error.message ?? String(error), { cause: error }));
      else resolve();
    }));
  }

  check(path) {
    path = workspacePath(path);
    let prefix = '';
    for (const part of path.split('/').filter(Boolean)) {
      prefix += `/${part}`;
      try {
        const resolved = this.FS.lookupPath(prefix, { follow: true }).path;
        if (resolved !== this.root && !resolved.startsWith(`${this.root}/`)) {
          fail('PATH_OUTSIDE_WORKSPACE', `Symlink resolves outside the workspace: ${path}`);
        }
      } catch (error) {
        if (error.code === 'PATH_OUTSIDE_WORKSPACE') throw error;
        if (error.errno === 44) break;
        throw error;
      }
    }
    return path;
  }

  operation(name, args) {
    try {
      const path = this.check(args.path);
      switch (name) {
        case 'writeFile': this.FS.writeFile(path, args.data); return;
        case 'readFile': {
          const stat = this.FS.stat(path);
          if (!this.FS.isFile(stat.mode)) fail('FILESYSTEM_ERROR', 'readFile requires a regular file');
          if (stat.size > this.maxBytes) fail('OUTPUT_LIMIT', 'File exceeds the configured maxOutputBytes');
          return new Uint8Array(this.FS.readFile(path));
        }
        case 'mkdir':
          if (args.recursive) this.FS.mkdirTree(path);
          else this.FS.mkdir(path);
          return;
        case 'readdir': return this.FS.readdir(path).filter((entry) => entry !== '.' && entry !== '..').sort();
        case 'stat': {
          const value = this.FS.stat(path);
          return { type: this.FS.isDir(value.mode) ? 'directory' : this.FS.isFile(value.mode) ? 'file' : 'other', size: value.size, mtime: value.mtime.getTime() };
        }
        case 'unlink':
          if (path === '/workspace') fail('INVALID_ARGUMENT', 'The workspace root cannot be removed');
          this.FS.unlink(path);
          return;
        default: fail('INVALID_ARGUMENT', `Unknown filesystem operation: ${name}`);
      }
    } catch (error) {
      if (error instanceof PHPWasmError) throw error;
      throw new PHPWasmError('FILESYSTEM_ERROR', `Filesystem ${name} failed: ${error.message ?? String(error)}`, { errno: error.errno, cause: error });
    }
  }

  release() { this.releaseLock?.(); this.releaseLock = null; }
}
