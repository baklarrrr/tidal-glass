// Browser regression uses a fake paired Android and the app's real encrypted dispatch.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');
const baseline = process.argv.includes('--baseline');
const root = path.resolve(process.env.SEEK_ROOT || path.join(__dirname,'..'));
const base = 'https://glasses.test';
const fresh = {t:'state',acc:true,ses:true,play:false,buf:false,ti:'Song',ar:'Artist',al:'Album',dur:260000,pos:50000,seek:true,q:[],qa:-1,vol:'8/15'};
const types = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'};
(async () => {
 const browser = await chromium.launch({executablePath:process.env.CHROME_PATH,args:['--disable-background-networking']});
 try {
  const page = await browser.newPage({viewport:{width:600,height:600},serviceWorkers:'block'});
  await page.routeWebSocket(/.*/,socket=>socket.close());
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if (url.origin!==base) return route.abort();
    const filename=path.join(root,url.pathname);
    try{return await route.fulfill({body:await fs.readFile(filename),contentType:types[path.extname(filename)]||'text/plain'});}
    catch{return route.abort();}
  });
  await page.addInitScript(()=>{
    window.inputAt=0;
    window.__sent=[];
    window.__testLink={connected:true,publish(_topic,body){window.__sent.push({at:performance.now(),body});},end(){}};
    document.addEventListener('keydown',e=>{if(e.target.id==='seek')window.inputAt=performance.now();},true);
  });
  await page.goto(base+'/index.html#androidBridge=seek-test~AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  if (await page.locator('#useAndroid').count()) {
    await page.click('#useAndroid');
  }
  await page.waitForFunction(()=>key!==null);
  const reset=async()=>{
    if (await page.locator('#useAndroid').isVisible()) await page.click('#useAndroid');
    await page.evaluate(async s=>{
      cancelSeek(); lastSeekKey=0;
      await handle(await seal({...s,at:Date.now()}),false);
      window.__sent.length=0;
    },fresh);
    await page.focus('#seek');
  };
  const seeks=()=>page.evaluate(async()=>(
    await Promise.all(window.__sent.map(async item=>({...await openMessage(item.body),at:item.at})))
  ).filter(m=>m.c==='seek'));
  const times=[];
  for(let i=0;i<5;i++) {
    await reset(); await page.keyboard.press('ArrowRight');
    let messages=[];
    for (let i=0;i<100&&!messages.length;i++) {
      messages=await seeks();
      if (!messages.length) await page.waitForTimeout(15);
    }
    assert.ok(messages.length,'seek must reach the fake broker');
    assert.equal(messages[0].ms,60000);
    times.push(Math.round((messages[0].at-await page.evaluate(()=>window.inputAt))*10)/10);
  }
  console.log((baseline?'Baseline':'Candidate')+' keydown to local encrypted publication (ms): '+JSON.stringify(times));
  if(baseline)return;
  assert.ok(times.every(ms=>ms<150),'isolated swipes must dispatch without a fixed wait');
  await reset();
  for(let i=0;i<6;i++){await page.keyboard.press('ArrowRight');await page.waitForTimeout(90);}
  await page.waitForTimeout(600);
  assert.deepEqual((await seeks()).map(m=>m.ms),[60000,240000]);
  await reset();await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(650);assert.deepEqual((await seeks()).map(m=>m.ms),[60000,50000]);
  for(const action of ['song','hide','next','target']) {
    await reset();await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight');
    if(action==='song') await page.evaluate(async s=>handle(await seal({...s,ar:'Different artist',at:Date.now()}),false),fresh);
    if(action==='hide') await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});document.dispatchEvent(new Event('visibilitychange'));});
    if(action==='next') await page.evaluate(()=>press('next'));
    if(action==='target') await page.evaluate(()=>typeof choosePhone==='function'?choosePhone():cancelSeek());
    await page.waitForTimeout(1900);
    assert.deepEqual((await seeks()).map(m=>m.ms),[60000],action+' cancels pending seek and resend');
    if(action==='hide') {
      await page.evaluate(()=>{delete document.visibilityState;document.dispatchEvent(new Event('visibilitychange'));});
    }
  }
  console.log('Passed isolated, accelerated, reverse, song switch, Next, hidden and target-change checks.');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
