import {api, esc, toast} from './common.js';

const app = document.querySelector('#app');
const recentKey = 'fieldroom.researcher.rooms';
function recentRooms() {
  try { return JSON.parse(localStorage.getItem(recentKey) || '[]'); }
  catch { return []; }
}
function renderHome() {
  const recent = recentRooms();
  document.querySelector('#status').textContent = '研究员工作台';
  app.innerHTML = `<div class="wrap home">
    <section class="intro"><div class="intro-copy"><p class="eyebrow">FIELDROOM / 现场研究室</p>
      <h1>线下用户研究<span>场次工作台</span></h1>
      <p class="lede">在同一 Wi-Fi 下分发问卷、查看受访者答卷，并在访谈中同步展示每个人的回答。</p>
    </div><div class="specimen" aria-hidden="true">
      <div class="sheet shadow-sheet"></div><div class="sheet main-sheet"><span class="sheet-head">FIELDROOM <b>受访者 A</b></span>
      <div class="sheet-lines"><i></i><i></i></div><strong>使用意愿</strong><div class="mini-scores"><i>1</i><i>2</i><i>3</i><i>4</i><i>5</i></div></div>
    </div></section>
    <div class="home-columns"><section class="panel create-panel"><h2>新建场次</h2>
    <form id="create" class="stack"><label class="field">场次名称<input name="title" placeholder="例如：星港探索 · 首轮试玩" required maxlength="100" autocomplete="off"></label>
    <label class="field">受访者人数<input name="count" type="number" value="6" min="1" max="200" required></label>
    <p class="muted hint">每位受访者都有一张自己的入场卡。</p>
    <button class="btn primary" type="submit">创建场次</button></form></section>
    <section class="panel recent-panel"><h2>最近场次</h2>` +
    (recent.length ? recent.map(room => `<a class="recent-item" href="/manage#${encodeURIComponent(room.admin)}"><strong>${esc(room.title)}</strong><small>${esc(room.date)}</small></a>`).join('') :
     '<div class="recent-empty"><span class="empty-icon" aria-hidden="true">≡</span><p>此浏览器还没有创建过场次</p></div>') +
    '</section></div></div>';
  app.querySelector('#create').onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const title = form.title.value.trim();
    if (!title) { form.title.value = ''; form.title.reportValidity(); return; }
    form.querySelector('button').disabled = true;
    try {
      const {admin} = await api('/api/create', {title, count:Number(form.count.value)});
      const room = {title, admin, date:new Date().toLocaleDateString('zh-CN')};
      try { localStorage.setItem(recentKey, JSON.stringify([room,...recent].slice(0,30))); } catch {}
      location.assign('/manage#' + encodeURIComponent(admin));
    } catch (error) { toast(error.message); form.querySelector('button').disabled = false; }
  };
}
const page = location.pathname.replace(/\/$/, '');
try {
  if (page === '/manage' || page === '/play') {
    const moduleName = page === '/manage' ? 'admin' : 'player';
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = '/static/' + moduleName + '.css';
    document.head.append(css);
    const mod = await import('./' + moduleName + '.js');
    await mod.start();
  } else if (page === '/join') {
    app.innerHTML = '<section class="panel join"><p class="eyebrow">受访者入口</p><h1>请扫入场卡</h1><p>用相机扫描自己的二维码，或打开研究员分配的专属链接。</p></section>';
  } else { renderHome(); }
} catch (error) {
  app.innerHTML = '<div class="wrap"><section class="panel"><h2>暂时无法打开</h2><p>' + esc(error.message) + '</p><button class="btn" id="retry">重新连接</button></section></div>';
  document.querySelector('#retry').onclick = () => location.reload();
}
