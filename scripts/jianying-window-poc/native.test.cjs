// Real Win32 windows in a dedicated fixture process; no user app is reparented.
const test=require('node:test'),assert=require('node:assert/strict'),{spawn,execFileSync}=require('node:child_process'),path=require('node:path');
function child(file,args=[]){
 const process=spawn(file,args,{windowsHide:true,stdio:['pipe','pipe','pipe']});const events=[],waiters=[];let text='';
 process.stdout.on('data',chunk=>{text+=chunk;let end;while((end=text.indexOf('\n'))>=0){const value=JSON.parse(text.slice(0,end));text=text.slice(end+1);events.push(value);for(const waiter of [...waiters])if(waiter.match(value)){clearTimeout(waiter.timer);waiters.splice(waiters.indexOf(waiter),1);waiter.resolve(value);}}});
 const wait=match=>new Promise((resolve,reject)=>{const waiter={match,resolve,timer:setTimeout(()=>reject(new Error(`Event timeout: ${JSON.stringify(events.slice(-4))}`)),5000)};waiters.push(waiter);});
 return {process,events,wait,send(line){process.stdin.write(line+'\n');},status(){const result=wait(value=>value.event==='native_status');this.send('status');return result;}};
}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixtureStatus(fixture){const result=fixture.wait(value=>value.event==='fixture_status');fixture.send('status');return result;}
test('native loop follows owner movement without JS heartbeats and synchronizes auxiliary visibility',async()=>{
 const fixture=child(path.join(__dirname,'../../build/jianying-window-poc/fixture/JianyingPro.exe'));let helper;
 try{
  const handles=await fixture.wait(value=>value.owner);
  helper=child(path.join(__dirname,'../../build/jianying-window-poc/window-host.exe'),['panel',String(handles.target),String(handles.owner),'60']);
  await helper.wait(value=>value.event==='attached');helper.send('viewport 200 100 700 600 1000 900');await pause(250);
  const first=await helper.status();assert.equal(first.panel.visible,true,`background focus must not hide the native canvas: ${JSON.stringify(first)}`);assert.equal(first.target.parent,first.panel.hwnd);
  fixture.send('focus-panel');await pause(150);
  const focus=(await fixtureStatus(fixture)).focusHwnd;
  assert.ok([handles.target,handles.text].includes(focus),`panel activation must hand keyboard focus to its editor: ${JSON.stringify({handles,focus,events:helper.events.slice(-8)})}`);
  fixture.send('send-key');await pause(100);assert.equal((await fixtureStatus(fixture)).editorKeys,1,'focused fixture must receive its native accelerator');
  fixture.send('focus-text');await pause(100);fixture.send('focus-panel');await pause(100);
  assert.equal((await fixtureStatus(fixture)).focusHwnd,handles.text,'reactivation must preserve the editor text input');
  fixture.send('focus-chat');await pause(150);helper.send('viewport 200 100 700 600 1000 900');await pause(200);
  assert.equal((await fixtureStatus(fixture)).focusHwnd,handles.chat,'layout and heartbeat must not steal keyboard focus from chat');
  fixture.send('send-key');await pause(100);const keys=await fixtureStatus(fixture);assert.equal(keys.editorKeys,1);assert.equal(keys.chatKeys,1,'chat keys must stay in chat');
  const denied=helper.wait(value=>value.event==='keyboard_focus' && value.reason==='explicit');helper.send('focus');assert.equal((await denied).ok,false,'background requests cannot activate a user app');
  await pause(6500);assert.equal((await helper.status()).panel.visible,true,'idle Chromium must not blank the native canvas after six seconds');
  fixture.send('move');await pause(250);
  const moved=await helper.status();assert.notEqual(moved.panel.rect.x,first.panel.rect.x);assert.equal(moved.target.client.width,Math.round(700*moved.owner.client.width/1000));
  helper.send('hide');await pause(150);assert.equal((await helper.status()).panel.visible,false);
  let auxiliary=fixture.wait(value=>value.event==='fixture_status');fixture.send('status');assert.equal((await auxiliary).auxiliaryVisible,false);
  helper.send('viewport 200 100 700 600 1000 900');await pause(150);assert.equal((await helper.status()).panel.visible,true);
  auxiliary=fixture.wait(value=>value.event==='fixture_status');fixture.send('status');assert.equal((await auxiliary).auxiliaryVisible,true);
  fixture.send('minimize');await pause(150);assert.equal((await helper.status()).panel.visible,false);
  fixture.send('restore');await fixtureStatus(fixture);await pause(150);const resumed=await helper.status();assert.equal(resumed.panel.visible,true,JSON.stringify(resumed));
  fixture.send('maximize-target');await pause(250);const normalized=await helper.status();assert.equal(normalized.target.parent,normalized.panel.hwnd);assert.equal(normalized.target.client.width,Math.round(700*normalized.owner.client.width/1000));
  fixture.send('hide-target');await pause(150);assert.equal((await helper.status()).panel.visible,false);
  const restored=helper.wait(value=>value.event==='restored');helper.send('handoff');assert.equal((await restored).ok,true);
  const exited=new Promise(resolve=>helper.process.once('exit',resolve));helper.process.stdin.end();assert.equal(await exited,0);
  const recovered=JSON.parse(execFileSync(path.join(__dirname,'../../build/jianying-window-poc/window-host.exe'),['show',String(handles.target)],{encoding:'utf8',windowsHide:true}));assert.equal(recovered.visible,true);assert.equal(recovered.parent,0);
 }finally{
  if(helper&&helper.process.exitCode===null){const closed=new Promise(resolve=>helper.process.once('exit',resolve));helper.process.stdin.end('detach\n');await closed;}
  const closed=new Promise(resolve=>fixture.process.once('exit',resolve));fixture.process.stdin.end('quit\n');await closed;
 }
});
