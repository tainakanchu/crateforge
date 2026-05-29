// dirB3.jsx — INTERACTIVE Cratebox list with a working ColumnPicker.
// Answers "can the list items be customized?" — toggle fields on/off, drag to reorder, switch density.
const { useState, useRef } = React;
const B3_W = 1180, B3_H = 760;

// Field registry. id, label, and a render(t) returning a small stat block.
const FIELD_DEFS = {
  album:  { label: 'Album',  w: 168, render: (t) => <span className="b3-v ell">{t.album}</span> },
  genre:  { label: 'Genre',  w: 104, render: (t) => <span className="b3-tag">{t.genre}</span> },
  key:    { label: 'Key',    w: 58,  render: (t) => <span className="b3-key">{t.key}</span> },
  bpm:    { label: 'BPM',    w: 58,  render: (t) => <span className="b3-mono" style={{ color: bpmColor(t.bpm), fontWeight: 650 }}>{t.bpm}</span> },
  rating: { label: 'Rating', w: 86,  render: (t) => <Stars value={t.rating} color="var(--ac)" size={12} /> },
  year:   { label: 'Year',   w: 56,  render: (t) => <span className="b3-mono b3-dim">{t.year}</span> },
  plays:  { label: 'Plays',  w: 52,  render: (t) => <span className="b3-mono b3-dim">{t.plays}</span> },
  time:   { label: 'Time',   w: 56,  render: (t) => <span className="b3-mono b3-dim">{t.time}</span> },
  energy: { label: 'Energy', w: 64,  render: (t) => (
    <span className="b3-en">{[0,1,2,3,4].map((k) => <i key={k} style={{ background: k < t.energy ? bpmColor(t.bpm) : undefined }} />)}</span>
  ) },
};
const ALL_FIELDS = ['key', 'bpm', 'album', 'genre', 'rating', 'year', 'plays', 'time', 'energy'];

function CrateboxLive() {
  const [fields, setFields] = useState(['key', 'bpm', 'album', 'genre', 'rating']);
  const [rowH, setRowH] = useState(40);          // adjustable row height (px)
  const [coverSize, setCoverSize] = useState(20); // 0 = off, 20 = 豆, 28 = 小
  const [pickerOpen, setPickerOpen] = useState(false);
  const dragIdx = useRef(null);

  const showArtist = rowH >= 50;

  function toggle(id) {
    setFields((f) => f.includes(id) ? f.filter((x) => x !== id) : [...f, id]);
  }
  function onDragStart(i) { dragIdx.current = i; }
  function onDragOver(e, i) {
    e.preventDefault();
    const from = dragIdx.current;
    if (from === null || from === i) return;
    setFields((f) => {
      const next = [...f];
      const [m] = next.splice(from, 1);
      next.splice(i, 0, m);
      dragIdx.current = i;
      return next;
    });
  }

  const css = `
  .b3{position:absolute;inset:0;background:#0E1113;color:#E4E7EA;display:flex;flex-direction:column;
    font:13px/1.4 -apple-system,"Segoe UI","Hiragino Sans","Noto Sans CJK JP","Noto Sans CJK SC",sans-serif;
    --ac:#27D2BC;--mut:#737A80;--bd:#22272B;--bg2:#161A1D;--bg3:#1E2429;letter-spacing:.1px;user-select:none;overflow:hidden;}
  .b3 *{box-sizing:border-box;}
  .b3-tb{display:flex;align-items:center;gap:10px;padding:13px 18px;border-bottom:1px solid var(--bd);position:relative;}
  .b3-title{font-weight:680;font-size:14px;}
  .b3-titlesub{color:var(--mut);font-size:11.5px;margin-left:2px;}
  .b3-sp{flex:1;}
  .b3-btn{display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 13px;border-radius:9px;background:var(--bg3);border:1px solid var(--bd);color:#C7CDD1;font-weight:600;font-size:12.5px;cursor:pointer;}
  .b3-btn svg{color:var(--mut);}
  .b3-btn:hover{border-color:#333a3f;}
  .b3-btn.on{background:rgba(39,210,188,.16);border-color:rgba(39,210,188,.42);color:#CFFAF4;} .b3-btn.on svg{color:var(--ac);}
  /* header */
  .b3-head{display:flex;align-items:center;gap:0;padding:0 18px;height:30px;border-bottom:1px solid var(--bd);color:var(--mut);font-size:10.5px;font-weight:600;letter-spacing:.6px;text-transform:uppercase;flex-shrink:0;}
  .b3-h-id{flex:1;}
  .b3-h-f{text-align:left;padding-left:2px;}
  /* rows */
  .b3-body{flex:1;overflow-y:auto;}
  .b3-row{display:flex;align-items:center;gap:0;padding:0 18px;border-bottom:1px solid rgba(255,255,255,.03);}
  .b3-row:hover{background:#13171A;} .b3-row:hover .b3-add{opacity:1;}
  .b3-row.play{background:rgba(39,210,188,.09);box-shadow:inset 3px 0 0 var(--ac);}
  .b3-id{flex:1;display:flex;align-items:center;gap:12px;min-width:0;}
  .b3-cov{flex-shrink:0;border-radius:8px;background:var(--ac);position:relative;overflow:hidden;box-shadow:0 3px 12px rgba(0,0,0,.4);}
  .b3-cov .g{position:absolute;inset:0;display:grid;place-items:center;font-weight:800;color:rgba(255,255,255,.92);font-family:"Hiragino Sans","Noto Sans CJK SC",sans-serif;text-shadow:0 2px 8px rgba(0,0,0,.35);}
  .b3-nm{min-width:0;}
  .b3-nm .t{font-weight:650;color:#F2F4F5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .b3-nm .a{color:#9DA2A8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .b3-f{display:flex;align-items:center;flex-shrink:0;overflow:hidden;}
  .b3-v{color:#C7CDD1;font-size:12.5px;} .b3-v.ell{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;}
  .b3-dim{color:#9DA2A8;}
  .b3-mono{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:12.5px;}
  .b3-key{font-family:ui-monospace,monospace;font-weight:650;color:var(--ac);font-size:12.5px;}
  .b3-tag{display:inline-flex;background:var(--bg3);border:1px solid var(--bd);border-radius:5px;padding:2px 8px;font-size:11px;color:#B7BCC1;}
  .b3-en{display:inline-flex;gap:2px;align-items:flex-end;}
  .b3-en i{width:3px;height:12px;border-radius:1px;background:var(--bg3);}
  .b3-add{opacity:0;width:32px;height:32px;border-radius:8px;display:grid;place-items:center;color:var(--ac);background:rgba(39,210,188,.13);cursor:pointer;flex-shrink:0;margin-left:6px;}
  /* picker popover */
  .b3-pop{position:absolute;top:54px;right:18px;width:288px;background:#171B1E;border:1px solid #2C3338;border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.6);z-index:30;overflow:hidden;}
  .b3-pophd{padding:13px 15px 11px;border-bottom:1px solid var(--bd);}
  .b3-pophd .t{font-weight:680;font-size:13px;}
  .b3-pophd .s{color:var(--mut);font-size:11px;margin-top:2px;}
  .b3-poplist{padding:7px;max-height:300px;overflow-y:auto;}
  .b3-pi{display:flex;align-items:center;gap:10px;padding:8px 9px;border-radius:9px;cursor:grab;}
  .b3-pi:hover{background:#1F2429;}
  .b3-pi.off{opacity:.5;}
  .b3-pi .grip{color:var(--mut);}
  .b3-pi .lbl{flex:1;font-size:13px;font-weight:550;color:#E4E7EA;}
  .b3-chk{width:20px;height:20px;border-radius:6px;border:1.5px solid #3A4248;display:grid;place-items:center;color:transparent;flex-shrink:0;}
  .b3-chk.on{background:var(--ac);border-color:var(--ac);color:#06211E;}
  .b3-popft{padding:12px 14px;border-top:1px solid var(--bd);display:flex;flex-direction:column;gap:11px;}
  .b3-ctrlrow{display:flex;align-items:center;gap:12px;}
  .b3-ctrll{flex:1;display:flex;align-items:center;justify-content:space-between;font-size:12px;color:#C7CDD1;font-weight:550;}
  .b3-ctrlv{font-family:ui-monospace,monospace;font-size:11.5px;color:var(--ac);}
  .b3-range{flex:1.2;-webkit-appearance:none;appearance:none;height:4px;border-radius:3px;background:var(--bg3);outline:none;}
  .b3-range::-webkit-slider-thumb{-webkit-appearance:none;width:15px;height:15px;border-radius:50%;background:var(--ac);cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.5);}
  .b3-range::-moz-range-thumb{width:15px;height:15px;border:0;border-radius:50%;background:var(--ac);cursor:pointer;}
  .b3-seg{display:flex;background:var(--bg3);border:1px solid var(--bd);border-radius:8px;padding:2px;gap:2px;}
  .b3-segb{padding:5px 10px;border-radius:6px;font-size:11.5px;font-weight:600;color:var(--mut);cursor:pointer;}
  .b3-segb.on{background:var(--ac);color:#06211E;}
  .b3-reset{font-size:11.5px;color:var(--mut);cursor:pointer;align-self:flex-start;}
  .b3-scrim{position:absolute;inset:0;z-index:20;}
  `;

  const rows = CTRACKS.slice(0, 9);
  const nowId = CTRACKS[8].id;

  return (
    <div className="b3">
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <div className="b3-tb">
        <span className="b3-title">All Tracks</span>
        <span className="b3-titlesub">· 華語 · 2,418</span>
        <span className="b3-sp"></span>
        <button className={'b3-btn' + (coverSize > 0 ? ' on' : '')} onClick={() => setCoverSize((v) => v > 0 ? 0 : 20)}>
          <Icon name="grid" size={15} /> Artwork
        </button>
        <button className={'b3-btn' + (pickerOpen ? ' on' : '')} onClick={() => setPickerOpen((v) => !v)}>
          <Icon name="sliders" size={15} /> Columns
          <span style={{ fontFamily: 'ui-monospace,monospace', fontSize: 11, opacity: .7 }}>{fields.length}</span>
        </button>
      </div>

      {/* column header reflects current fields */}
      <div className="b3-head">
        <span className="b3-h-id">Track</span>
        {fields.map((id) => (
          <span key={id} className="b3-h-f" style={{ width: FIELD_DEFS[id].w }}>{FIELD_DEFS[id].label}</span>
        ))}
        <span style={{ width: 38 }}></span>
      </div>

      <div className="b3-body">
        {rows.map((t) => (
          <div key={t.id} className={'b3-row' + (t.id === nowId ? ' play' : '')} style={{ height: rowH }}>
            <div className="b3-id">
              {coverSize > 0 && (
                <div className="b3-cov" style={{ width: coverSize, height: coverSize, background: artGradient(t.album) }}>
                  <span className="g" style={{ fontSize: coverSize * 0.5 }}>{t.name[0]}</span>
                </div>
              )}
              <div className="b3-nm">
                <div className="t" style={{ fontSize: rowH < 44 ? 13 : 14.5 }}>{t.name}</div>
                {showArtist && <div className="a" style={{ fontSize: 12 }}>{t.artist}</div>}
              </div>
            </div>
            {fields.map((id) => (
              <span key={id} className="b3-f" style={{ width: FIELD_DEFS[id].w }}>{FIELD_DEFS[id].render(t)}</span>
            ))}
            <span className="b3-add"><Icon name="plus" size={16} /></span>
          </div>
        ))}
      </div>

      {pickerOpen && <div className="b3-scrim" onClick={() => setPickerOpen(false)}></div>}
      {pickerOpen && (
        <div className="b3-pop">
          <div className="b3-pophd">
            <div className="t">Customize columns</div>
            <div className="s">ドラッグで並べ替え・タップで表示切替</div>
          </div>
          <div className="b3-poplist">
            {/* selected first (draggable), then available */}
            {fields.map((id, i) => (
              <div key={id} className="b3-pi" draggable
                onDragStart={() => onDragStart(i)} onDragOver={(e) => onDragOver(e, i)} onDragEnd={() => (dragIdx.current = null)}>
                <span className="grip"><Icon name="dragHandle" size={15} /></span>
                <span className="lbl">{FIELD_DEFS[id].label}</span>
                <span className="b3-chk on" onClick={() => toggle(id)}><Icon name="check" size={13} /></span>
              </div>
            ))}
            {ALL_FIELDS.filter((id) => !fields.includes(id)).length > 0 && (
              <div style={{ padding: '8px 9px 4px', fontSize: 10, letterSpacing: '.6px', textTransform: 'uppercase', color: 'var(--mut)', fontWeight: 600 }}>Available</div>
            )}
            {ALL_FIELDS.filter((id) => !fields.includes(id)).map((id) => (
              <div key={id} className="b3-pi off" onClick={() => toggle(id)}>
                <span className="grip"><Icon name="plus" size={15} /></span>
                <span className="lbl">{FIELD_DEFS[id].label}</span>
                <span className="b3-chk"><Icon name="check" size={13} /></span>
              </div>
            ))}
          </div>
          <div className="b3-popft">
            <div className="b3-ctrlrow">
              <div className="b3-ctrll"><span>Row height</span><span className="b3-ctrlv">{rowH}px</span></div>
              <input className="b3-range" type="range" min="32" max="64" step="2" value={rowH} onChange={(e) => setRowH(+e.target.value)} />
            </div>
            <div className="b3-ctrlrow">
              <div className="b3-ctrll"><span>Artwork</span></div>
              <div className="b3-seg">
                <span className={'b3-segb' + (coverSize === 0 ? ' on' : '')} onClick={() => setCoverSize(0)}>なし</span>
                <span className={'b3-segb' + (coverSize === 20 ? ' on' : '')} onClick={() => setCoverSize(20)}>豆</span>
                <span className={'b3-segb' + (coverSize === 28 ? ' on' : '')} onClick={() => setCoverSize(28)}>小</span>
              </div>
            </div>
            <span className="b3-reset" onClick={() => { setFields(['key', 'bpm', 'album', 'genre', 'rating']); setRowH(40); setCoverSize(20); }}>Reset to defaults</span>
          </div>
        </div>
      )}
    </div>
  );
}
window.CrateboxLive = CrateboxLive; window.B3_W = B3_W; window.B3_H = B3_H;
