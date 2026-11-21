// Exercises the delivered UI with seven separate player storage contexts.
// All tokens and QR images stay in memory. The test owns its database and server.
const {chromium} = require('playwright-core');
const {PNG} = require('pngjs');
const decodeQR = require('jsqr');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const readline = require('node:readline');

const root = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const scores = ['2','4','3','5','1','4'];
const title = '星港探索 · 六人试玩';
const willingness = '你有多愿意再玩一局？';
const screenshots = process.env.FIELDROOM_SCREENSHOTS;
let stage = '启动';
async function until(check, label, timeout=12000) {
  const start = Date.now();
  while (Date.now()-start < timeout) {
    if (await check()) return;
    await delay(80);
  }
  throw new Error('等待超时 · ' + label);
}
function button(page, name) { return page.getByRole('button',{name,exact:true}); }
async function capture(page, file, selector) {
  if (!screenshots) return;
  fs.mkdirSync(screenshots,{recursive:true});
  await page.locator('#notice').waitFor({state:'hidden'});
  const target = selector ? page.locator(selector) : page;
  await target.screenshot({path:path.join(screenshots,file)});
}
async function exercise(browser, base) {
  const errors = [];
  async function pageInNewContext(viewport) {
    const context = await browser.newContext({viewport});
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror',err=>errors.push(err.name));
    return page;
  }
  const admin = await pageInNewContext({width:1280,height:900});
  await admin.goto(base);
  await capture(admin,'cover.png','.intro');
  await admin.locator('[name=title]').fill(title);
  await button(admin,'创建场次').click();
  await admin.locator('#room-title').waitFor();
  const adminKey = new URL(admin.url()).hash.slice(1);
  async function inspect(route) {
    const res = await admin.request.get(base+route,{headers:{Authorization:'Bearer '+adminKey}});
    assert.equal(res.status(),200);
    return res.json();
  }
  let room = await inspect('/api/manage');
  const detail = player => inspect('/api/manage/player?id='+room.players[player].id);
  stage = '生成并解码六张入场卡';
  await button(admin,'入场卡').click();
  await until(()=>admin.locator('.card-qr img').evaluateAll(imgs=>imgs.length===6 && imgs.every(i=>i.naturalWidth>0)),stage);
  const links = [];
  for (let index=0;index<6;index++) {
    const bytes = await admin.locator('.card-qr img').nth(index).screenshot();
    const image = PNG.sync.read(bytes);
    const qr = decodeQR(new Uint8ClampedArray(image.data),image.width,image.height);
    assert.ok(qr,'二维码应能从浏览器渲染图像解码');
    const url = new URL(qr.data);
    assert.ok(url.origin===base && url.pathname==='/play' && url.hash.slice(1)===room.players[index].code);
    links.push(url.href);
  }
  const players = await Promise.all(links.map(async(link,index)=>{
    const page = await pageInNewContext({width:390+index*15,height:844});
    await page.goto(link);
    await page.getByRole('heading',{name:'受访者 '+String.fromCharCode(65+index)}).waitFor();
    return page;
  }));
  await button(admin,'问卷编排').click();
  async function open(form) {
    await admin.locator('[data-action="pick-form"][data-value="'+form.id+'"]').click();
    await button(admin,'开放问卷').click();
    await until(async()=> (await inspect('/api/manage')).forms.find(f=>f.id===form.id).open,'后台开放问卷');
  }
  async function fillForm(page, index, form) {
    await page.locator('[data-form="'+form.id+'"]').click();
    for(const q of form.questions) {
      const field = page.getByRole('group',{name:q.label,exact:true});
      if(q.type==='text') await field.locator('textarea').fill('希望星图提示更清楚 · '+(index+1));
      else {
        const value = q.type==='rating' ? scores[index] : q.options[index%q.options.length];
        await field.locator('label').filter({has:page.getByRole('radio',{name:value,exact:true})}).click();
      }
    }
    await button(page,'提交问卷').click();
    await page.locator('#player-survey .badge.good').waitFor();
  }
  for(let number=0;number<3;number++) {
    stage = '六人提交第 '+(number+1)+' 份问卷';
    const form = room.forms[number];
    await open(form);
    await Promise.all(players.map((page,index)=>fillForm(page,index,form)));
    if(number===0) {
      stage = '提交六条体验问题';
      await Promise.all(players.map(async(page,index)=>{
        await button(page,'体验问题').click();
        await page.locator('#issue-text').fill('第一次进星港时没看到任务标记 · '+(index+1));
        await button(page,'提交问题').click();
        await page.locator('.issue-item').waitFor();
        await button(page,'我的问卷').click();
      }));
    }
  }
  room = await inspect('/api/manage');
  assert.ok(room.players.every(p=>p.submitted.length===3));
  await button(admin,'场次概览').click();
  await until(()=>admin.locator('.progress-text b').evaluateAll(items=>items.length===3 && items.every(item=>item.textContent==='6')),'后台三份问卷均显示六人已交');
  await admin.mouse.move(8,8);
  await capture(admin,'session-overview.png');
  stage = '六人群访、跨卷切题与草稿';
  const interview = async (qid) => {
    await admin.locator('#preview-question').selectOption(qid);
    await button(admin,'向受访者展示').click();
  };
  const rating = room.forms[0].questions[0];
  const third = room.forms[2].questions[0];
  await button(admin,'访谈控制').click();
  await interview(third.id);
  await Promise.all(players.map(p=>p.getByRole('heading',{name:third.label}).waitFor()));
  await interview(rating.id);
  for (const [index,p] of players.entries()) {
    await p.getByRole('heading',{name:willingness}).waitFor();
    assert.equal(await p.locator('.live-answer').textContent(),scores[index]);
  }
  await capture(players[0],'player-interview.png','.player-wrap');
  await capture(players[1],'participant-b.png','.player-wrap');
  const a = players[0];
  stage = '个人回看、刷新和返回访谈';
  await button(a,'回看我的问卷').click();
  const visibleScore = a.getByRole('group',{name:willingness}).getByRole('radio',{name:'2',exact:true});
  assert.ok(await visibleScore.isChecked(),'应打开访谈题所在的已交问卷');
  await a.reload();
  await visibleScore.waitFor({state:'attached'});
  assert.ok(await visibleScore.isChecked(),'刷新后仍可回看自己的答案');
  for (const p of players.slice(1)) assert.ok(await p.locator('.live-answer').isVisible());
  await button(a,'返回访谈').click();
  await a.locator('.live-answer').waitFor();
  assert.equal(await a.locator('.live-answer').textContent(),'2');
  await button(a,'回看我的问卷').click();
  await a.locator('[data-form="'+room.forms[1].id+'"]').click();
  const openText = room.forms[1].questions.find(q=>q.type==='text');
  await a.getByRole('textbox',{name:openText.label}).fill('回看时补充：星图标记太小');
  await interview(openText.id);
  await a.getByRole('heading',{name:openText.label}).waitFor();
  assert.equal(await a.locator('.live-answer').textContent(),'回看时补充：星图标记太小');
  await interview(rating.id);
  await a.getByRole('heading',{name:willingness}).waitFor();
  await admin.locator('[data-action=supplement]').first().click();
  await admin.locator('[name=score]').selectOption('4');
  await admin.locator('[name=reason]').fill('第二局掌握了连招');
  await button(admin,'保存补充').click();
  await until(async()=> (await detail(0)).supplements.some(s=>s.score==='4'),'访谈补充落库');
  assert.equal(await a.locator('.live-answer').textContent(),'2');
  await button(a,'回看我的问卷').click();
  await button(admin,'结束访谈').click();
  await button(a,'返回访谈').waitFor({state:'detached'});
  assert.ok(await visibleScore.isChecked(),'主持人结束访谈后仍能回看');
  await a.locator('#player-survey').waitFor();
  await button(a,'体验问题').click();
  await a.locator('#issue-text').fill('传送门提示太短，想再看一次');
  await interview(rating.id);
  await a.locator('.live-answer').waitFor();
  assert.ok((await detail(0)).notes.some(n=>!n.submitted && n.text==='传送门提示太短，想再看一次'));
  await button(admin,'结束访谈').click();
  await a.locator('#issue-text').waitFor();
  assert.equal(await a.locator('#issue-text').inputValue(),'传送门提示太短，想再看一次');
  stage = '换机、旧设备断网重连和最新评分';
  await button(a,'我的问卷').click();
  await a.locator('[data-form="'+room.forms[0].id+'"]').click();
  await a.context().setOffline(true);
  await a.getByRole('group',{name:willingness}).locator('label').filter({hasText:'1'}).click();
  await interview(rating.id);
  const newA = await pageInNewContext({width:820,height:1000});
  await newA.goto(links[0]);
  await newA.locator('.live-answer').waitFor();
  assert.equal(await newA.locator('.live-answer').textContent(),'2');
  await button(admin,'结束访谈').click();
  await newA.locator('[data-form="'+room.forms[0].id+'"]').click();
  await newA.getByRole('group',{name:willingness}).locator('label').filter({hasText:'5'}).click();
  await until(async()=> (await detail(0)).answers[rating.id]==='5','新设备直接改分');
  await a.context().setOffline(false);
  await a.waitForURL('**/join');
  const updated = await detail(0);
  assert.equal(updated.answers[rating.id],'5');
  assert.ok(updated.history.some(h=>h.qid===rating.id && h.value==='2'));
  assert.ok(updated.history.some(h=>h.qid===rating.id && h.value==='5'));
  assert.ok(updated.notes.some(n=>n.submitted));
  stage = '双主持人并行单访和群访';
  const secondAdmin = await pageInNewContext({width:1024,height:768});
  await secondAdmin.goto(admin.url());
  await button(secondAdmin,'访谈控制').click();
  const roster = room.players;
  const target = (page, id) => page.locator('[name=target][value="'+id+'"]');
  const groupControl = (page, id) => page.locator('[data-action=pick-interview][data-value="'+id+'"]');
  for (const player of roster.slice(1)) await target(admin,player.id).uncheck();
  await interview(rating.id);
  await newA.getByRole('heading',{name:willingness}).waitFor();
  const soloId = (await inspect('/api/manage')).interviews[0].id;
  await groupControl(secondAdmin,soloId).waitFor();
  await secondAdmin.locator('[data-action=new-interview]').click();
  assert.ok(await target(secondAdmin,roster[0].id).isDisabled(),'A 已在单访中');
  for (const player of roster.slice(1)) await target(secondAdmin, player.id).check();
  await secondAdmin.locator('#preview-question').selectOption(third.id);
  await button(secondAdmin,'向受访者展示').click();
  await Promise.all(players.slice(1).map(page=>page.getByRole('heading',{name:third.label}).waitFor()));
  const groupId = (await inspect('/api/manage')).interviews.find(g=>g.id!==soloId).id;
  await groupControl(admin,groupId).waitFor();
  await secondAdmin.reload();
  await button(secondAdmin,'访谈控制').click();
  await until(async()=>await groupControl(secondAdmin,groupId).getAttribute('aria-pressed')==='true','刷新后继续管理所选组');
  assert.equal(await groupControl(admin,soloId).getAttribute('aria-pressed'),'true');
  assert.ok(await newA.getByRole('heading',{name:willingness}).isVisible());
  await capture(admin,'parallel-interviews.png','.group-directory');

  // One host can inspect the other group without changing any participant screen.
  await groupControl(admin,groupId).click();
  assert.equal(await admin.locator('#preview-question').inputValue(),third.id);
  await groupControl(admin,soloId).click();
  const nextQuestion = room.forms[1].questions[0];
  await interview(nextQuestion.id);
  await newA.getByRole('heading',{name:nextQuestion.label}).waitFor();
  for (const page of players.slice(1)) assert.ok(await page.getByRole('heading',{name:third.label}).isVisible());
  await button(admin,'结束访谈').click();
  await newA.locator('#player-survey').waitFor();
  assert.deepEqual((await inspect('/api/manage')).interviews.map(g=>g.id),[groupId]);
  assert.ok(await button(admin,'封存场次').isDisabled());
  await secondAdmin.locator('#preview-question').selectOption(rating.id);
  await button(secondAdmin,'向受访者展示').click();
  await Promise.all(players.slice(1).map(page=>page.getByRole('heading',{name:willingness}).waitFor()));
  for (const [i,page] of players.slice(1).entries()) assert.equal(await page.locator('.live-answer').textContent(),scores[i+1]);
  await button(secondAdmin,'结束访谈').click();
  await until(()=>button(admin,'封存场次').isEnabled(),'两组结束后解除封存限制');
  await secondAdmin.context().close();
  console.log('PASS · 双主持人 · 一人单访与五人群访 · 独立切题、回卷与结束');
  stage = '封存和重新开放';
  await button(admin,'封存场次').click();
  await button(admin,'确认封存').click();
  await until(()=>newA.locator('input[type=radio]').first().isDisabled(),'整场只读');
  await button(admin,'重新开放场次').click();
  await until(()=>newA.locator('input[type=radio]').first().isEnabled(),'重新开放后可改');
  assert.deepEqual(errors,[]);
  console.log('PASS · 6 张二维码解码 · 6 个隔离会话 · 18 份交卷 · 6 条体验问题');
  console.log('PASS · 跨卷切题及个人评分 2/4/3/5/1/4 · 访谈补充 · 草稿同步与恢复');
  console.log('PASS · 个人回看与返回 · 刷新恢复 · 修改后再次跟题 · 结束后继续回看');
  console.log('PASS · 第七个会话换机 · 离线旧设备退出 · 历史评分 · 封存和重开');
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'fieldroom-test-'));
  const python = process.env.PYTHON || (process.platform==='win32' ? 'python' : 'python3');
  const server = spawn(python,[path.join(root,'server.py'),'--host','127.0.0.1','--port','0','--db',path.join(temp,'test.sqlite')],{
    env:{...process.env,FIELDROOM_BASE_URL:undefined},stdio:['ignore','pipe','inherit']
  });
  let browser;
  try {
    const lines = readline.createInterface({input:server.stdout});
    const [line] = await Promise.race([once(lines,'line'),once(server,'exit').then(()=>{throw Error('服务启动失败');})]);
    const base = line.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    assert.ok(base,'服务地址不可用');
    lines.close();
    browser = await chromium.launch(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {channel:'chrome'});
    await exercise(browser,base);
  } finally {
    if(browser) await browser.close();
    if(server.exitCode===null && server.signalCode===null) {const ended=once(server,'exit');server.kill();await ended;}
    fs.rmSync(temp,{recursive:true,force:true});
  }
}
main().catch(error=>{
  // Playwright diagnostics can contain URL fragments or player identifiers.
  const safeMessage = String(error.message).replace(/(\/play|\/manage)#[^\s"']+/g,'$1#[hidden]');
  console.error('FAIL · '+stage+' · '+safeMessage);
  process.exitCode=1;
});
