// dirB2.jsx — "Cratebox · Art-forward" : Direction B refined for cover-led recognition.
// Big covers everywhere, pinyin/latin reading under every CJK title, cover-strip crate.
const BB_W = 1480, BB_H = 924;

// Larger placeholder cover: gradient + the leading glyph (works great for CJK).
function Cover({ seed, glyph, size, radius = 10, style }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: radius, flexShrink: 0,
      background: artGradient(seed), position: 'relative', overflow: 'hidden',
      boxShadow: '0 4px 14px rgba(0,0,0,.4)', ...style,
    }}>
      <span style={{
        position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
        fontSize: size * 0.42, fontWeight: 800, color: 'rgba(255,255,255,.9)',
        fontFamily: '"Hiragino Sans","Noto Sans CJK SC",sans-serif', letterSpacing: '-.02em',
        textShadow: '0 2px 8px rgba(0,0,0,.35)',
      }}>{glyph}</span>
    </div>
  );
}

function CrateboxArt({ mode = 'list' }) {
  const css = `
  .bb{position:absolute;inset:0;display:grid;grid-template-columns:202px 1fr 348px;grid-template-rows:1fr 78px;
    font:13px/1.4 -apple-system,"Segoe UI","Hiragino Sans","Noto Sans CJK JP","Noto Sans CJK SC",sans-serif;
    color:#E4E7EA;background:#0E1113;--ac:#27D2BC;--ac-d:#0E6B62;--mut:#737A80;--bd:#22272B;--bg2:#161A1D;--bg3:#1E2429;letter-spacing:.1px;user-select:none;overflow:hidden;}
  .bb *{box-sizing:border-box;}
  .bb-side{grid-column:1;grid-row:1/2;background:#0A0D0F;border-right:1px solid var(--bd);display:flex;flex-direction:column;min-height:0;}
  .bb-brand{display:flex;align-items:center;gap:9px;padding:15px 15px 11px;}
  .bb-logo{width:24px;height:24px;border-radius:7px;background:var(--ac);display:grid;place-items:center;color:#06211E;}
  .bb-brand b{font-weight:680;letter-spacing:.3px;font-size:14px;}
  .bb-lbl{font-size:10px;font-weight:600;letter-spacing:1.4px;color:var(--mut);text-transform:uppercase;padding:9px 15px 4px;display:flex;justify-content:space-between;align-items:center;}
  .bb-nav{display:flex;align-items:center;gap:10px;padding:7px 15px;color:#B7BCC1;cursor:default;border-radius:0 9px 9px 0;margin-right:10px;}
  .bb-nav.on{background:rgba(39,210,188,.14);color:#EAFBF8;} .bb-nav.on svg{color:var(--ac);} .bb-nav svg{color:var(--mut);}
  .bb-nav:hover:not(.on){background:#13171A;}
  .bb-pl{flex:1;overflow:hidden;}
  .bb-prow{display:flex;align-items:center;gap:8px;padding:5px 15px;color:#A7ACB2;cursor:default;}
  .bb-prow:hover{background:#13171A;} .bb-prow .ct{margin-left:auto;font-size:11px;color:var(--mut);font-variant-numeric:tabular-nums;}
  .bb-prow.fold{color:#CFD3D7;font-weight:550;}
  /* main */
  .bb-main{grid-column:2;grid-row:1/2;display:flex;flex-direction:column;min-width:0;min-height:0;}
  .bb-tb{display:flex;align-items:center;gap:9px;padding:13px 20px;border-bottom:1px solid var(--bd);}
  .bb-sbox{flex:1;display:flex;align-items:center;gap:10px;background:var(--bg2);border:1px solid var(--bd);border-radius:10px;padding:9px 13px;color:var(--mut);max-width:440px;}
  .bb-sbox input{background:none;border:0;color:#E4E7EA;font:inherit;width:100%;outline:none;}
  .bb-seg{display:flex;background:var(--bg3);border:1px solid var(--bd);border-radius:9px;padding:3px;gap:2px;}
  .bb-segb{padding:7px 13px;border-radius:7px;color:var(--mut);font-size:12px;font-weight:650;cursor:pointer;display:flex;align-items:center;gap:6px;}
  .bb-segb.on{background:var(--ac);color:#06211E;}
  .bb-sort{margin-left:auto;display:flex;align-items:center;gap:7px;color:#A7ACB2;font-size:12px;font-weight:600;cursor:pointer;}
  .bb-chips{display:flex;gap:7px;padding:10px 20px;border-bottom:1px solid var(--bd);align-items:center;flex-wrap:wrap;}
  .bb-chip{display:inline-flex;align-items:center;gap:6px;height:27px;padding:0 11px;border-radius:14px;background:var(--bg3);border:1px solid var(--bd);font-size:11.5px;color:#B7BCC1;cursor:pointer;}
  .bb-chip.on{background:rgba(39,210,188,.16);border-color:rgba(39,210,188,.4);color:#CFFAF4;}
  .bb-chip svg{color:var(--mut);} .bb-chip.on svg{color:var(--ac);}
  /* LIST mode */
  .bb-body{flex:1;overflow:hidden;}
  .bb-trow{display:grid;grid-template-columns:64px 1.5fr 1fr 96px 64px 48px;align-items:center;gap:0;padding:0 20px;height:74px;border-bottom:1px solid rgba(255,255,255,.035);}
  .bb-trow:hover{background:#13171A;} .bb-trow:hover .bb-add{opacity:1;}
  .bb-trow.play{background:rgba(39,210,188,.09);box-shadow:inset 3px 0 0 var(--ac);}
  .bb-trow.incrate{background:rgba(39,210,188,.045);}
  .bb-titlecell{min-width:0;padding-right:14px;}
  .bb-cjk{font-size:16px;font-weight:650;color:#F2F4F5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.25;}
  .bb-sub2{font-size:13px;color:#A7ADB3;font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px;}
  .bb-album{font-size:12.5px;color:#9DA2A8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:14px;}
  .bb-genreline{display:inline-flex;margin-top:5px;font-size:10.5px;color:#9DA2A8;background:var(--bg3);border:1px solid var(--bd);border-radius:5px;padding:2px 7px;}
  .bb-kb{display:flex;flex-direction:column;gap:4px;align-items:flex-start;}
  .bb-keychip{display:inline-flex;align-items:center;gap:5px;font:12px ui-monospace,monospace;font-weight:650;color:var(--ac);background:rgba(39,210,188,.1);border-radius:6px;padding:2px 8px;}
  .bb-bpmchip{font:12px ui-monospace,monospace;font-weight:650;}
  .bb-add{opacity:0;width:34px;height:34px;border-radius:9px;display:grid;place-items:center;color:var(--ac);background:rgba(39,210,188,.13);cursor:pointer;justify-self:end;}
  .bb-check{width:34px;height:34px;border-radius:9px;display:grid;place-items:center;color:var(--ac);justify-self:end;}
  /* COVERS mode */
  .bb-grid{flex:1;overflow:hidden;padding:18px 20px;display:grid;grid-template-columns:repeat(5,1fr);gap:18px;align-content:start;}
  .bb-cardwrap{cursor:pointer;}
  .bb-card{position:relative;width:100%;aspect-ratio:1;border-radius:13px;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,.42);}
  .bb-card .glyph{position:absolute;inset:0;display:grid;place-items:center;font-size:62px;font-weight:800;color:rgba(255,255,255,.92);font-family:"Hiragino Sans","Noto Sans CJK SC",sans-serif;text-shadow:0 3px 14px rgba(0,0,0,.4);}
  .bb-card .grad{position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,.78),transparent 52%);}
  .bb-card .ov{position:absolute;left:12px;right:12px;bottom:11px;}
  .bb-card .ov .cj{font-size:14.5px;font-weight:680;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .bb-card .ov .la{font-size:11.5px;color:#BFEFE8;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px;}
  .bb-card .kbtag{position:absolute;left:11px;top:11px;display:flex;gap:6px;}
  .bb-card .kbtag span{background:rgba(0,0,0,.5);backdrop-filter:blur(6px);border-radius:7px;padding:3px 8px;font:11px ui-monospace,monospace;font-weight:650;}
  .bb-card .addbtn{position:absolute;right:11px;top:11px;width:34px;height:34px;border-radius:50%;background:var(--ac);color:#06211E;display:grid;place-items:center;opacity:0;transform:scale(.85);transition:.16s;}
  .bb-cardwrap:hover .addbtn{opacity:1;transform:none;} .bb-cardwrap:hover .bb-card{outline:2px solid var(--ac);outline-offset:2px;}
  .bb-card.incrate{outline:2px solid var(--ac);outline-offset:2px;}
  /* RIGHT RAIL */
  .bb-rail{grid-column:3;grid-row:1/3;background:#0A0D0F;border-left:1px solid var(--bd);display:flex;flex-direction:column;min-height:0;}
  .bb-now{padding:16px 16px 14px;border-bottom:1px solid var(--bd);}
  .bb-nowart{width:100%;aspect-ratio:1;border-radius:14px;position:relative;overflow:hidden;box-shadow:0 14px 40px rgba(0,0,0,.5);}
  .bb-nowart .g{position:absolute;inset:0;display:grid;place-items:center;font-size:96px;font-weight:800;color:rgba(255,255,255,.92);font-family:"Hiragino Sans","Noto Sans CJK SC",sans-serif;text-shadow:0 4px 18px rgba(0,0,0,.4);}
  .bb-nowart .ov{position:absolute;left:13px;bottom:13px;display:flex;gap:7px;}
  .bb-nowart .ov span{background:rgba(0,0,0,.5);backdrop-filter:blur(8px);border-radius:8px;padding:5px 10px;font:12px ui-monospace,monospace;font-weight:650;}
  .bb-nowmeta{margin-top:13px;}
  .bb-nowmeta .cj{font-size:18px;font-weight:700;color:#F2F4F5;}
  .bb-nowmeta .la{font-size:13px;color:var(--ac);font-weight:650;margin-top:2px;}
  .bb-nowmeta .ar{font-size:12.5px;color:var(--mut);margin-top:3px;}
  .bb-railtabs{display:flex;gap:4px;padding:11px 13px 9px;}
  .bb-tab{flex:1;text-align:center;padding:7px 0;border-radius:8px;font-size:12px;font-weight:650;color:var(--mut);cursor:pointer;}
  .bb-tab.on{background:var(--bg3);color:#EAFBF8;}
  .bb-cratehd{padding:3px 15px 9px;display:flex;align-items:center;justify-content:space-between;}
  .bb-cratehd b{font-weight:680;font-size:13px;}
  .bb-cmeta{font-size:11px;color:var(--mut);}
  .bb-cmeta b{color:var(--ac);font-variant-numeric:tabular-nums;}
  .bb-cratelist{flex:1;overflow:hidden;padding:2px 11px;}
  .bb-cnode{display:flex;align-items:center;gap:10px;padding:7px;border-radius:10px;}
  .bb-cnode:hover{background:#13171A;}
  .bb-cgrip{color:var(--mut);cursor:grab;}
  .bb-cmetawrap{min-width:0;flex:1;}
  .bb-cmetawrap .cj{font-size:13px;font-weight:600;color:#E4E7EA;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .bb-cmetawrap .la{font-size:11px;color:var(--mut);display:flex;gap:7px;}
  .bb-cmetawrap .la b{color:var(--ac);}
  .bb-cratefoot{padding:13px;border-top:1px solid var(--bd);display:flex;gap:8px;}
  .bb-big{flex:1;height:40px;border-radius:11px;background:var(--ac);color:#06211E;font-weight:700;display:flex;align-items:center;justify-content:center;gap:8px;cursor:pointer;}
  .bb-ghost{height:40px;width:44px;border-radius:11px;border:1px solid var(--bd);background:var(--bg3);display:grid;place-items:center;color:#B7BCC1;cursor:pointer;}
  /* PLAYER */
  .bb-player{grid-column:1/3;grid-row:2;background:#0A0D0F;border-top:1px solid var(--bd);display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:24px;padding:0 22px;}
  .bb-pl{display:flex;align-items:center;gap:13px;min-width:0;}
  .bb-pa-meta{min-width:0;}
  .bb-pa-meta .cj{font-weight:680;color:#F2F4F5;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .bb-pa-meta .la{font-size:12px;color:var(--ac);font-weight:600;}
  .bb-ctr{display:flex;flex-direction:column;align-items:center;gap:8px;}
  .bb-ctrl{display:flex;align-items:center;gap:18px;color:#C2C7CC;}
  .bb-pp{width:40px;height:40px;border-radius:50%;background:var(--ac);color:#06211E;display:grid;place-items:center;cursor:pointer;}
  .bb-seek{display:flex;align-items:center;gap:11px;width:440px;font:11px ui-monospace,monospace;color:var(--mut);}
  .bb-wave{flex:1;height:28px;display:flex;align-items:center;gap:2px;}
  .bb-wave i{flex:1;border-radius:2px;background:var(--bd);}
  .bb-pr{display:flex;align-items:center;gap:12px;justify-content:flex-end;color:var(--mut);}
  .bb-vbar{width:92px;height:4px;border-radius:3px;background:var(--bg3);position:relative;}
  .bb-vbar i{position:absolute;inset:0 38% 0 0;background:#8C9197;border-radius:3px;}
  .bb-tg.on{color:var(--ac);}
  `;
  const now = CTRACKS[8];          // 夜曲 Yèqǔ
  const crate = [CTRACKS[8], CTRACKS[9], CTRACKS[3], CTRACKS[13]];
  const inCrateIds = new Set(crate.map((t) => t.id));
  const filters = [['key', '1B · harmonic', true], ['sliders', '116–132 BPM', true], ['star', '4★+', false], ['tag', 'Mandopop', false], ['plus', 'Filter', false]];
  const listRows = CTRACKS.slice(0, 9);
  const gridItems = CTRACKS.slice(0, 10);

  return (
    <div className="bb">
      <style dangerouslySetInnerHTML={{ __html: css }} />
      {/* sidebar */}
      <aside className="bb-side">
        <div className="bb-brand"><div className="bb-logo"><Icon name="layers" size={14} /></div><b>Cratebox</b></div>
        <div className="bb-lbl">Library</div>
        <div className="bb-nav on"><Icon name="music" size={16} /> All Tracks</div>
        <div className="bb-nav"><Icon name="disc" size={16} /> Albums</div>
        <div className="bb-nav"><Icon name="mic" size={16} /> Artists</div>
        <div className="bb-nav"><Icon name="clock" size={16} /> Recently Played</div>
        <div className="bb-lbl">Playlists <Icon name="plus" size={13} /></div>
        <div className="bb-pl">
          {[{ name: 'C-POP Sets', fold: true }, { name: '華語 Peak', c: 312 }, { name: 'Mandopop Slow', c: 188 },
            { name: 'Jay Chou ♥', c: 96 }, { name: 'Jolin Dance', c: 74 }, { name: 'City Pop', c: 805 },
            { name: 'Favorite J-POP', c: 2190 }, { name: 'Favorite House', c: 805 }, { name: 'Future Funk', c: 525 }].map((p, i) => (
            <div key={i} className={'bb-prow' + (p.fold ? ' fold' : '')}>
              <Icon name={p.fold ? 'folder' : 'music'} size={13} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
              {p.c != null && <span className="ct">{p.c.toLocaleString()}</span>}
            </div>
          ))}
        </div>
      </aside>
      {/* main */}
      <div className="bb-main">
        <div className="bb-tb">
          <div className="bb-sbox"><Icon name="search" size={15} /><input placeholder="搜尋 / Search title, artist, album…" readOnly /></div>
          <div className="bb-seg">
            <span className={'bb-segb' + (mode === 'list' ? ' on' : '')}><Icon name="list" size={14} /> List</span>
            <span className={'bb-segb' + (mode === 'covers' ? ' on' : '')}><Icon name="grid" size={14} /> Covers</span>
          </div>
          <span className="bb-sort">Sort: Key <Icon name="chevronD" size={12} /></span>
        </div>
        <div className="bb-chips">
          {filters.map(([ic, lb, on], i) => (
            <span key={i} className={'bb-chip' + (on ? ' on' : '')}><Icon name={ic} size={13} /> {lb}</span>
          ))}
        </div>
        {mode === 'list' ? (
          <div className="bb-body">
            {listRows.map((t, i) => {
              const inCrate = inCrateIds.has(t.id);
              return (
                <div key={t.id} className={'bb-trow' + (t.id === now.id ? ' play' : '') + (inCrate ? ' incrate' : '')}>
                  <Cover seed={t.album} glyph={t.name[0]} size={54} radius={9} />
                  <div className="bb-titlecell">
                    <div className="bb-cjk">{t.name}</div>
                    <div className="bb-sub2">{t.artist}</div>
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div className="bb-album">{t.album}</div>
                    <div><span className="bb-genreline">{t.genre}</span></div>
                  </div>
                  <div className="bb-kb">
                    <span className="bb-keychip"><Icon name="key" size={11} /> {t.key}</span>
                    <span className="bb-bpmchip" style={{ color: bpmColor(t.bpm) }}>{t.bpm} BPM</span>
                  </div>
                  <Stars value={t.rating} color="var(--ac)" size={12} />
                  {inCrate
                    ? <span className="bb-check"><Icon name="check" size={18} /></span>
                    : <span className="bb-add"><Icon name="plus" size={17} /></span>}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="bb-grid">
            {gridItems.map((t) => {
              const inCrate = inCrateIds.has(t.id);
              return (
                <div key={t.id} className="bb-cardwrap">
                  <div className={'bb-card' + (inCrate ? ' incrate' : '')} style={{ background: artGradient(t.album) }}>
                    <span className="glyph">{t.name[0]}</span>
                    <span className="grad"></span>
                    <div className="kbtag">
                      <span style={{ color: '#27D2BC' }}>{t.key}</span>
                      <span style={{ color: bpmColor(t.bpm) }}>{t.bpm}</span>
                    </div>
                    <span className="addbtn">{inCrate ? <Icon name="check" size={17} /> : <Icon name="plus" size={17} />}</span>
                    <div className="ov">
                      <div className="cj">{t.name}</div>
                      <div className="la">{t.artist.split(' (')[0]}</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {/* right rail */}
      <aside className="bb-rail">
        <div className="bb-now">
          <div className="bb-nowart" style={{ background: artGradient(now.album) }}>
            <span className="g">{now.name[0]}</span>
            <div className="ov">
              <span><span style={{ color: '#27D2BC' }}>{now.key}</span> · <span style={{ color: bpmColor(now.bpm) }}>{now.bpm}</span></span>
              <span style={{ color: '#27D2BC' }}>♥ {now.rating}★</span>
            </div>
          </div>
          <div className="bb-nowmeta">
            <div className="cj">{now.name}</div>
            <div className="ar">{now.artist} — {now.album}</div>
          </div>
        </div>
        <div className="bb-railtabs">
          <span className="bb-tab">Now Playing</span>
          <span className="bb-tab">Up Next</span>
          <span className="bb-tab on">Crate</span>
        </div>
        <div className="bb-cratehd">
          <b>Staging Crate</b>
          <span className="bb-cmeta"><b>{crate.length}</b> tracks · <b>16:46</b></span>
        </div>
        <div className="bb-cratelist">
          {crate.map((t) => (
            <div key={t.id} className="bb-cnode">
              <span className="bb-cgrip"><Icon name="dragHandle" size={15} /></span>
              <Cover seed={t.album} glyph={t.name[0]} size={42} radius={8} />
              <div className="bb-cmetawrap">
                <div className="cj">{t.name}</div>
                <div className="la"><b>{t.key}</b> · <span style={{ color: bpmColor(t.bpm) }}>{t.bpm}</span> · {t.artist.split(' (')[0]}</div>
              </div>
              <Icon name="x" size={14} style={{ color: 'var(--mut)' }} />
            </div>
          ))}
        </div>
        <div className="bb-cratefoot">
          <button className="bb-big"><Icon name="check" size={15} /> Save as Playlist</button>
          <button className="bb-ghost" title="Play crate"><Icon name="play" size={15} fill="currentColor" stroke={0} /></button>
        </div>
      </aside>
      {/* player */}
      <div className="bb-player">
        <div className="bb-pl">
          <Cover seed={now.album} glyph={now.name[0]} size={48} radius={9} />
          <div className="bb-pa-meta">
            <div className="cj">{now.name}</div>
            <div className="la">{now.artist.split(' (')[0]} · <span style={{ color: '#27D2BC' }}>{now.key}</span> · {now.bpm}</div>
          </div>
        </div>
        <div className="bb-ctr">
          <div className="bb-ctrl">
            <Icon name="shuffle" size={16} className="bb-tg" />
            <Icon name="prev" size={18} />
            <span className="bb-pp"><Icon name="pause" size={16} fill="currentColor" stroke={0} /></span>
            <Icon name="next" size={18} />
            <Icon name="repeat" size={16} className="bb-tg on" />
          </div>
          <div className="bb-seek"><span>1:44</span>
            <div className="bb-wave">{Array.from({ length: 68 }).map((_, i) => {
              const h = 6 + Math.abs(Math.sin(i * 0.6) * 18) + (i % 3) * 2;
              return <i key={i} style={{ height: h, background: i < 30 ? '#27D2BC' : undefined }} />;
            })}</div>
            <span>3:46</span></div>
        </div>
        <div className="bb-pr"><Icon name="queue" size={16} /><Icon name="volume" size={16} /><div className="bb-vbar"><i></i></div></div>
      </div>
    </div>
  );
}
window.CrateboxArt = CrateboxArt; window.BB_W = BB_W; window.BB_H = BB_H;
