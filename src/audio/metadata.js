// jsmediatags wrapper + small formatters.

export function readTags(file) {
  return new Promise((resolve, reject) => {
    if (!window.jsmediatags) { resolve(null); return; }
    window.jsmediatags.read(file, {
      onSuccess: ({ tags }) => {
        const out = {};
        if (tags.title)  out.title  = String(tags.title);
        if (tags.artist) out.artist = String(tags.artist);
        if (tags.album)  out.album  = String(tags.album);
        if (tags.picture) {
          const { data, format } = tags.picture;
          let b64 = '';
          for (let i = 0; i < data.length; i++) b64 += String.fromCharCode(data[i]);
          out.picture = `data:${format};base64,${btoa(b64)}`;
        }
        resolve(out);
      },
      onError: (err) => reject(err),
    });
  });
}

export function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '00:00';
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

export function basenameWithoutExt(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}
