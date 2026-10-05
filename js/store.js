// Local library in IndexedDB: projects (photo, depth, settings, thumbnail)
// and user looks. Nothing leaves the device.

const DB = 'vathography-studio';
let dbp = null;

function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('projects', { keyPath: 'id' });
      d.createObjectStore('assets');
      d.createObjectStore('looks', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

async function tx(stores, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(stores, mode);
    let out;
    Promise.resolve(fn(...stores.map((s) => t.objectStore(s)))).then((v) => { out = v; });
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Storage transaction aborted (disk full?)'));
  });
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const store = {
  async persist() { try { return await navigator.storage?.persist?.(); } catch { return false; } },
  async usage() { try { return await navigator.storage?.estimate?.(); } catch { return null; } },

  async listProjects() {
    const all = await tx(['projects'], 'readonly', (p) => req(p.getAll()));
    return all.sort((a, b) => b.updated - a.updated);
  },
  async getProject(id) {
    return tx(['projects', 'assets'], 'readonly', async (p, a) => {
      const meta = await req(p.get(id));
      if (!meta) return null;
      const [photo, raw, depth] = await Promise.all([req(a.get(id + ':photo')), req(a.get(id + ':raw')), req(a.get(id + ':depth'))]);
      return { ...meta, photo, raw, depth };
    });
  },
  // meta: {id,name,created,updated,settings,thumb,photoName,proc,...}; assets optional
  async saveProject(meta, assets = {}) {
    return tx(['projects', 'assets'], 'readwrite', (p, a) => {
      p.put(meta);
      for (const [k, v] of Object.entries(assets)) if (v !== undefined) a.put(v, meta.id + ':' + k);
    });
  },
  async deleteProject(id) {
    return tx(['projects', 'assets'], 'readwrite', (p, a) => {
      p.delete(id);
      for (const k of ['photo', 'raw', 'depth']) a.delete(id + ':' + k);
    });
  },
  async listLooks() { return tx(['looks'], 'readonly', (l) => req(l.getAll())); },
  async saveLook(look) { return tx(['looks'], 'readwrite', (l) => { l.put(look); }); },
  async deleteLook(id) { return tx(['looks'], 'readwrite', (l) => { l.delete(id); }); },
};
