// data.jsx — shared mock data + helpers for all directions.

// Deterministic "album art" color from a string → a 2-stop gradient.
function artGradient(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  const h2 = (h + 38) % 360;
  return `linear-gradient(140deg, hsl(${h} 52% 46%), hsl(${h2} 58% 30%))`;
}
function artSolid(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `hsl(${h} 46% 42%)`;
}
function initials(s) {
  const t = (s || '').replace(/^["'\s]+/, '');
  return (t[0] || '?').toUpperCase();
}

// Musical key for DJ feel (Camelot-ish)
const KEYS = ['8A','5A','11B','2A','7B','9A','4B','12A','1B','6A','10B','3A'];

// rating 0-5
const TRACKS = [
  { name: '!?', artist: 'すのうまん', album: 'H.B.S.001', genre: 'Dance', rating: 1, plays: 1, time: '5:52', bpm: 60 },
  { name: 'Good-night.', artist: 'Cymbals', album: 'Mr. Noone Special', genre: 'J-POP', rating: 1, plays: 0, time: '3:04', bpm: 60 },
  { name: 'HELLO!! (M@STER VERSION)', artist: '日高愛, 水谷絵理, 秋月涼', album: 'THE IDOLM@STER 765PRO ALLSTARS+', genre: 'Anime', rating: 1, plays: 0, time: '4:11', bpm: 173 },
  { name: 'Kyun', artist: '佳苗', album: 'こち亀百歌選〜主題歌ベスト', genre: 'Anime', rating: 1, plays: 0, time: '4:03', bpm: 126 },
  { name: 'sunrise,sunset', artist: '緒方恵美', album: 'rain', genre: 'J-POP', rating: 2, plays: 0, time: '4:34', bpm: 134 },
  { name: 'S同士', artist: "Tomato n' Pine", album: 'Life is beautiful', genre: 'J-POP', rating: 3, plays: 4, time: '2:09', bpm: 126 },
  { name: '"What" are you?', artist: 'Photon Maiden', album: 'Cosmic CoaSTAR', genre: 'Anime', rating: 2, plays: 1, time: '3:28', bpm: 152 },
  { name: 'スイッチオン', artist: "Tomato n' Pine", album: 'Life is beautiful', genre: 'J-POP', rating: 4, plays: 3, time: '2:32', bpm: 122 },
  { name: 'ダンスレッスン09110', artist: "Tomato n' Pine", album: 'Life is beautiful', genre: 'J-POP', rating: 2, plays: 2, time: '0:45', bpm: 126 },
  { name: 'トントンパ', artist: "Tomato n' Pine", album: 'Life is beautiful', genre: 'J-POP', rating: 5, plays: 6, time: '1:51', bpm: 137 },
  { name: '青春病', artist: '藤井 風', album: 'LOVE ALL SERVE ALL', genre: 'J-POP', rating: 4, plays: 0, time: '5:24', bpm: 108 },
  { name: '#', artist: '慢慢說', album: '1+1<3', genre: 'T-POP', rating: 5, plays: 0, time: '3:09', bpm: 70 },
  { name: 'Night Tempo Remix', artist: 'Night Tempo', album: 'Showa Groove', genre: 'Future Funk', rating: 4, plays: 12, time: '3:41', bpm: 118 },
  { name: 'Plastic Love', artist: '竹内まりや', album: 'VARIETY', genre: 'City Pop', rating: 5, plays: 28, time: '4:54', bpm: 103 },
  { name: 'Stay With Me', artist: '松原みき', album: 'POCKET PARK', genre: 'City Pop', rating: 5, plays: 19, time: '4:12', bpm: 96 },
  { name: 'Midnight Pretenders', artist: '亜蘭知子', album: 'Florescence', genre: 'City Pop', rating: 4, plays: 7, time: '5:33', bpm: 110 },
  { name: 'flyday chinatown', artist: '泰葉', album: 'Fui ni', genre: 'City Pop', rating: 4, plays: 9, time: '4:48', bpm: 124 },
  { name: 'リップシンク', artist: 'tofubeats', album: 'FANTASY CLUB', genre: 'Electronica', rating: 4, plays: 5, time: '4:05', bpm: 128 },
  { name: 'Baby Blue', artist: 'iri', album: 'Sparkle', genre: 'R&B', rating: 4, plays: 3, time: '3:52', bpm: 92 },
  { name: 'シャル・ウィ・ダンス?', artist: 'cero', album: 'POLY LIFE MULTI SOUL', genre: 'Art Pop', rating: 5, plays: 14, time: '5:18', bpm: 116 },
].map((t, i) => ({ ...t, id: i + 1, key: KEYS[i % KEYS.length], missing: false }));

const PODCASTS = [
  '#01 リクルートを選択することでキャリアの幅を広げた…',
  '#02 サイバーエージェントを経てタイのスタートアップで…',
  '#03 社内転籍で機会を自ら作り成長した女性エンジニア…',
  '#04 海外で起業して気づいた日本人エンジニアの価値',
  '#05 起業での失敗をバネに、LayerXで価値発揮する…',
].map((name, i) => ({
  id: 100 + i, name, artist: '', album: 'エンジニアトーク「ROLE MODEL」',
  genre: 'ポッドキャスト', rating: 0, plays: 0, time: ['20:43','18:39','19:41','23:58','19:43'][i], bpm: 0, key: '', missing: true,
}));

const PLAYLISTS = [
  { name: 'Favorite', icon: 'folder', isFolder: true, depth: 0 },
  { name: 'BPM sort', icon: 'folder', isFolder: true, depth: 1 },
  { name: '< 70', count: 496, depth: 2 },
  { name: '100 – 120', count: 996, depth: 2 },
  { name: '115 – 135', count: 1925, depth: 2 },
  { name: '130 – 155', count: 1277, depth: 2 },
  { name: '140 – 165', count: 809, depth: 2 },
  { name: '165 – 185', count: 1091, depth: 2 },
  { name: '180 <', count: 362, depth: 2 },
  { name: 'Favorite 2step', count: 179, depth: 0 },
  { name: 'Favorite Aikatsu Remix', count: 340, depth: 0 },
  { name: 'Favorite DnB', count: 298, depth: 0 },
  { name: 'Favorite Electronica', count: 200, depth: 0 },
  { name: 'Favorite FutureBass', count: 525, depth: 0 },
  { name: 'Favorite House', count: 805, depth: 0 },
  { name: 'Favorite J-POP', count: 2190, depth: 0 },
  { name: 'Favorite Remix', count: 1496, depth: 0 },
];

const ALBUMS = [
  { title: 'Life is beautiful', artist: "Tomato n' Pine", tracks: 12, time: '42:18', genre: 'J-POP' },
  { title: 'LOVE ALL SERVE ALL', artist: '藤井 風', tracks: 11, time: '48:55', genre: 'J-POP' },
  { title: 'VARIETY', artist: '竹内まりや', tracks: 10, time: '46:30', genre: 'City Pop' },
  { title: 'POCKET PARK', artist: '松原みき', tracks: 10, time: '40:12', genre: 'City Pop' },
  { title: 'FANTASY CLUB', artist: 'tofubeats', tracks: 12, time: '51:07', genre: 'Electronica' },
  { title: 'POLY LIFE MULTI SOUL', artist: 'cero', tracks: 11, time: '54:39', genre: 'Art Pop' },
  { title: 'Showa Groove', artist: 'Night Tempo', tracks: 9, time: '36:44', genre: 'Future Funk' },
  { title: 'Cosmic CoaSTAR', artist: 'Photon Maiden', tracks: 8, time: '33:21', genre: 'Anime' },
  { title: 'Sparkle', artist: 'iri', tracks: 10, time: '43:50', genre: 'R&B' },
  { title: 'H.B.S.001', artist: 'V.A.', tracks: 14, time: '58:02', genre: 'Dance' },
];

const STATS = { tracks: '36,460', playlists: 200, time: '2464h 19m', missing: 20 };

// BPM → color band (DJ-ish energy)
function bpmColor(bpm) {
  if (!bpm) return 'var(--muted)';
  if (bpm < 90) return '#5BA8E0';
  if (bpm < 115) return '#46C28A';
  if (bpm < 135) return '#E0C24A';
  if (bpm < 160) return '#E08A3C';
  return '#E0573C';
}

// Chinese-language / C-pop crate — art-forward demo. romaji/EN hint = how a non-reader recognizes it.
const CTRACKS = [
  { name: '愛在西元前', latin: 'Ài Zài Xīyuán Qián', artist: '周杰倫 (Jay Chou)', album: '范特西 Fantasy', genre: 'Mandopop', rating: 5, plays: 22, time: '3:54', bpm: 96, key: '8A' },
  { name: '小幸運', latin: 'Xiǎo Xìngyùn', artist: '田馥甄 (Hebe Tien)', album: '我的少女時代 OST', genre: 'C-Pop', rating: 5, plays: 31, time: '4:24', bpm: 74, key: '5A' },
  { name: '醉赤壁', latin: 'Zuì Chìbì', artist: '林俊傑 (JJ Lin)', album: '靠岸', genre: 'Mandopop', rating: 4, plays: 12, time: '4:08', bpm: 88, key: '11B' },
  { name: '日不落', latin: 'Rì Bù Luò', artist: '蔡依林 (Jolin Tsai)', album: '特務J', genre: 'C-Pop Dance', rating: 4, plays: 18, time: '3:40', bpm: 128, key: '2A' },
  { name: '倒帶', latin: 'Dào Dài', artist: '蔡依林 (Jolin Tsai)', album: '城堡', genre: 'Mandopop', rating: 4, plays: 9, time: '4:11', bpm: 80, key: '7B' },
  { name: '我懷念的', latin: 'Wǒ Huáiniàn De', artist: '孫燕姿 (Stefanie Sun)', album: '逆光', genre: 'C-Pop', rating: 5, plays: 27, time: '4:38', bpm: 72, key: '9A' },
  { name: 'princess', latin: 'princess', artist: '徐佳瑩 (LaLa Hsu)', album: 'LALA首張創作專輯', genre: 'C-Pop', rating: 4, plays: 6, time: '3:58', bpm: 102, key: '4B' },
  { name: '小酒窩', latin: 'Xiǎo Jiǔwō', artist: '林俊傑 & 蔡卓妍', album: 'JJ陸', genre: 'Mandopop', rating: 4, plays: 14, time: '4:21', bpm: 110, key: '12A' },
  { name: '夜曲', latin: 'Yèqǔ (Nocturne)', artist: '周杰倫 (Jay Chou)', album: '十一月的蕭邦', genre: 'Mandopop', rating: 5, plays: 41, time: '3:46', bpm: 124, key: '1B' },
  { name: '光年之外', latin: 'Guāngnián Zhī Wài', artist: 'G.E.M. 鄧紫棋', album: 'Passenger OST', genre: 'C-Pop', rating: 4, plays: 16, time: '3:55', bpm: 118, key: '6A' },
  { name: '泡沫', latin: 'Pàomò (Bubble)', artist: 'G.E.M. 鄧紫棋', album: 'Xposed', genre: 'C-Pop', rating: 5, plays: 33, time: '4:31', bpm: 70, key: '10B' },
  { name: '演員', latin: 'Yǎnyuán (Actor)', artist: '薛之謙 (Joker Xue)', album: '紳士', genre: 'Mandopop', rating: 4, plays: 11, time: '4:21', bpm: 84, key: '3A' },
  { name: '體面', latin: 'Tǐmiàn (Decent)', artist: '于文文 (Kelly Yu)', album: '前任3 OST', genre: 'C-Pop', rating: 4, plays: 8, time: '4:05', bpm: 76, key: '8A' },
  { name: '達爾文', latin: 'Dáěrwén (Darwin)', artist: '周杰倫 (Jay Chou)', album: '依然范特西', genre: 'Mandopop', rating: 4, plays: 7, time: '4:18', bpm: 132, key: '5A' },
].map((t, i) => ({ ...t, id: 200 + i, missing: false, year: [2001, 2015, 2008, 2009, 2006, 2007, 2009, 2008, 2005, 2016, 2012, 2015, 2017, 2006][i], energy: [4, 2, 3, 5, 2, 2, 3, 4, 5, 4, 2, 3, 3, 5][i] }));

Object.assign(window, { TRACKS, CTRACKS, PODCASTS, PLAYLISTS, ALBUMS, STATS, artGradient, artSolid, initials, bpmColor, KEYS });
