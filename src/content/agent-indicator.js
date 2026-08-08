/**
 * Delta Agent - Visual Indicator
 *
 * Injects a pulsing overlay and a "Stop Agent" button when the agent is active.
 * Listens for messages from background: SHOW_AGENT_INDICATOR, HIDE_AGENT_INDICATOR.
 */
(function () {
  let glowEl = null;
  let stopBtnEl = null;
  let isActive = false;

  const BRAND_COLOR = 'rgba(79, 70, 229, '; // Indigo brand

  function injectStyles() {
    if (document.getElementById('delta-agent-styles')) return;
    const style = document.createElement('style');
    style.id = 'delta-agent-styles';
    style.textContent = `
      @keyframes delta-pulse {
        0%   { box-shadow: inset 0 0 10px ${BRAND_COLOR}0.5), inset 0 0 20px ${BRAND_COLOR}0.3); }
        50%  { box-shadow: inset 0 0 18px ${BRAND_COLOR}0.8), inset 0 0 35px ${BRAND_COLOR}0.5); }
        100% { box-shadow: inset 0 0 10px ${BRAND_COLOR}0.5), inset 0 0 20px ${BRAND_COLOR}0.3); }
      }
      @keyframes delta-slide-up {
        from { transform: translateX(-50%) translateY(80px); opacity: 0; }
        to   { transform: translateX(-50%) translateY(0);   opacity: 1; }
      }
    `;
    document.head.appendChild(style);
  }

  function createGlow() {
    const el = document.createElement('div');
    el.id = 'delta-agent-glow';
    el.style.cssText = `
      position: fixed; inset: 0;
      pointer-events: none;
      z-index: 2147483645;
      animation: delta-pulse 2s ease-in-out infinite;
      transition: opacity 0.3s ease;
      opacity: 0;
    `;
    return el;
  }

  function createStopButton() {
    const container = document.createElement('div');
    container.id = 'delta-agent-stop-container';
    container.style.cssText = `
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%) translateY(80px);
      z-index: 2147483647;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.3s ease;
    `;

    const btn = document.createElement('button');
    btn.id = 'delta-agent-stop-btn';
    btn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="margin-right:8px;vertical-align:middle;">
        <rect x="6" y="6" width="12" height="12" rx="2"/>
      </svg>
      <span style="vertical-align:middle;">Parar Agente</span>
    `;
    btn.style.cssText = `
      display: inline-flex;
      align-items: center;
      padding: 10px 18px;
      background: #fff;
      color: #202124;
      border: 1px solid rgba(32,33,36,0.28);
      border-radius: 24px;
      font-family: 'Google Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      pointer-events: auto;
      box-shadow: 0 2px 10px rgba(79,70,229,0.3), 0 1px 3px rgba(0,0,0,0.15);
      transition: box-shadow 0.2s, background 0.2s;
      user-select: none;
      white-space: nowrap;
    `;
    btn.addEventListener('mouseenter', () => {
      btn.style.background = '#f8f9fa';
      btn.style.boxShadow = '0 4px 18px rgba(79,70,229,0.4), 0 2px 6px rgba(0,0,0,0.2)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = '#fff';
      btn.style.boxShadow = '0 2px 10px rgba(79,70,229,0.3), 0 1px 3px rgba(0,0,0,0.15)';
    });
    btn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'STOP_AGENT' });
    });

    container.appendChild(btn);
    return container;
  }

  function showIndicator() {
    if (isActive) return;
    isActive = true;
    injectStyles();

    if (!glowEl) {
      glowEl = createGlow();
      document.body.appendChild(glowEl);
    }
    if (!stopBtnEl) {
      stopBtnEl = createStopButton();
      document.body.appendChild(stopBtnEl);
    }

    glowEl.style.display = '';
    stopBtnEl.style.display = '';

    requestAnimationFrame(() => {
      glowEl.style.opacity = '1';
      stopBtnEl.style.opacity = '1';
      stopBtnEl.style.animation = 'delta-slide-up 0.35s cubic-bezier(0.2,0,0,1) forwards';
    });
  }

  function hideIndicator() {
    if (!isActive) return;
    isActive = false;

    if (glowEl) glowEl.style.opacity = '0';
    if (stopBtnEl) {
      stopBtnEl.style.opacity = '0';
      stopBtnEl.style.transform = 'translateX(-50%) translateY(80px)';
    }

    setTimeout(() => {
      if (!isActive) {
        glowEl?.remove(); glowEl = null;
        stopBtnEl?.remove(); stopBtnEl = null;
      }
    }, 350);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'SHOW_AGENT_INDICATOR') {
      showIndicator();
      sendResponse({ success: true });
    } else if (msg.type === 'HIDE_AGENT_INDICATOR') {
      hideIndicator();
      sendResponse({ success: true });
    }
  });

  window.addEventListener('beforeunload', hideIndicator);
})();
