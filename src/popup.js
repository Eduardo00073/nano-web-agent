document.getElementById('open-panel').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.runtime.sendMessage({ type: 'OPEN_SIDEPANEL', tabId: tab.id });
    window.close();
  }
});

document.getElementById('open-settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});
