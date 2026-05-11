// jsmediatags wrapper + small formatters.

// Standard ID3v1 genre table (indices 0-147)
const ID3_GENRES = [
  'Blues','Classic Rock','Country','Dance','Disco','Funk','Grunge','Hip-Hop','Jazz',
  'Metal','New Age','Oldies','Other','Pop','R&B','Rap','Reggae','Rock','Techno',
  'Industrial','Alternative','Ska','Death Metal','Pranks','Soundtrack','Euro-Techno',
  'Ambient','Trip-Hop','Vocal','Jazz+Funk','Fusion','Trance','Classical','Instrumental',
  'Acid','House','Game','Sound Clip','Gospel','Noise','Alternative Rock','Bass','Soul',
  'Punk','Space','Meditative','Instrumental Pop','Instrumental Rock','Ethnic','Gothic',
  'Darkwave','Techno-Industrial','Electronic','Pop-Folk','Eurodance','Dream',
  'Southern Rock','Comedy','Cult','Gangsta','Top 40','Christian Rap','Pop/Funk',
  'Jungle','Native US','Cabaret','New Wave','Psychedelic','Rave','Showtunes','Trailer',
  'Lo-Fi','Tribal','Acid Punk','Acid Jazz','Polka','Retro','Musical','Rock & Roll',
  'Hard Rock','Folk','Folk-Rock','National Folk','Swing','Fast Fusion','Bebop','Latin',
  'Revival','Celtic','Bluegrass','Avantgarde','Gothic Rock','Progressive Rock',
  'Psychedelic Rock','Symphonic Rock','Slow Rock','Big Band','Chorus','Easy Listening',
  'Acoustic','Humour','Speech','Chanson','Opera','Chamber Music','Sonata','Symphony',
  'Booty Bass','Primus','Porn Groove','Satire','Slow Jam','Club','Tango','Samba',
  'Folklore','Ballad','Power Ballad','Rhythmic Soul','Freestyle','Duet','Punk Rock',
  'Drum Solo','A Capella','Euro-House','Dance Hall','Goa','Drum & Bass','Club-House',
  'Hardcore','Terror','Indie','BritPop','Afro-Punk','Polsk Punk','Beat',
  'Christian Gangsta Rap','Heavy Metal','Black Metal','Crossover',
  'Contemporary Christian','Christian Rock','Merengue','Salsa','Thrash Metal',
  'Anime','JPop','Synthpop',
];

// Parse an ID3 TCON string into an array of human-readable genre strings.
// Handles: "(17)", "(17)(52)", "Rock", "Rock/Electronic", null-byte separated.
export function parseGenres(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const genres = new Set();

  // Extract all numeric codes like (17)
  const numRe = /\((\d+)\)/g;
  let m;
  while ((m = numRe.exec(raw)) !== null) {
    const idx = parseInt(m[1], 10);
    if (idx >= 0 && idx < ID3_GENRES.length) genres.add(ID3_GENRES[idx]);
  }

  // Strip numeric refs and split remaining text
  const rest = raw.replace(/\(\d+\)/g, '').trim();
  if (rest) {
    rest.split(/[\0;,]+/).map((s) => s.replace(/\//g, ' / ').trim()).filter(Boolean)
      .forEach((g) => { if (g !== 'RX' && g !== 'CR') genres.add(g); });
  }

  return [...genres].slice(0, 4);
}

export function readTags(file) {
  return new Promise((resolve, reject) => {
    if (!window.jsmediatags) { resolve(null); return; }
    window.jsmediatags.read(file, {
      onSuccess: ({ tags }) => {
        const out = {};
        if (tags.title)   out.title  = String(tags.title);
        if (tags.artist)  out.artist = String(tags.artist);
        if (tags.album)   out.album  = String(tags.album);
        // Keep raw {data, format} so extractThemeHue can build a Blob from it
        if (tags.picture) out.picture = tags.picture;
        if (tags.genre)   out.genres = parseGenres(String(tags.genre));
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
