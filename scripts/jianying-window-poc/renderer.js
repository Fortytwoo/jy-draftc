document.querySelector('#close').addEventListener('click', () => window.poc.close());
if (new URLSearchParams(location.search).get('manual') === '1') {
  document.querySelector('#mode').textContent = '人工操作 · POC 验证';
  document.querySelector('#steps-title').textContent = '由你操作，逐项核验';
  document.querySelector('#steps').textContent = '播放 → 分割 → 字幕 → 音量 → 保存重开';
  document.querySelector('#input-title').textContent = '记录与结束';
  document.querySelector('#input-info').textContent = '每完成一步，点击“记录当前画面”。30 分钟后自动恢复窗口，工程中的编辑不会撤销。';
  const button = document.querySelector('#checkpoint'); button.hidden = false;
  button.addEventListener('click', async () => {
    button.disabled = true;
    const status = document.querySelector('#capture-status');
    status.textContent = '正在记录…';
    try { const result = await window.poc.checkpoint(); status.textContent = result.saved ? `已记录第 ${result.index} 张画面` : '未记录，请保持 POC 在前台后重试'; }
    catch { status.textContent = '记录失败，请保留当前窗口并反馈'; }
    finally { button.disabled = false; }
  });
}
window.poc.onEvent(value => {
  document.querySelector('#log').textContent += `${new Date().toLocaleTimeString()}  ${value.event}\n`;
});
