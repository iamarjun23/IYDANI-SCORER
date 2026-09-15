export function initUpdater() {
  const updater = window.hamsleka?.updater;
  if (!updater) return;

  // Register listeners
  updater.onAvailable((info) => {
    console.log('Update available:', info);
  });

  updater.onProgress((percent) => {
    console.log(`Update download progress: ${percent}%`);
  });

  updater.onReady((info) => {
    console.log('Update ready to install:', info);
    showUpdateUI(info);
  });

  updater.onError((err) => {
    console.error('Update error:', err);
  });
}

function showUpdateUI(info) {
  // Clean up any existing updater elements
  const existingOverlay = document.getElementById('updater-overlay');
  const existingBanner = document.getElementById('updater-banner');
  if (existingOverlay) existingOverlay.remove();
  if (existingBanner) existingBanner.remove();

  if (info.critical) {
    // Show full-screen blocking modal
    const overlay = document.createElement('div');
    overlay.id = 'updater-overlay';
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.85)';
    overlay.style.zIndex = '9999';
    overlay.style.display = 'flex';
    overlay.style.flexDirection = 'column';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.color = '#ffffff';
    overlay.style.fontFamily = 'inherit';
    overlay.style.padding = '20px';
    overlay.style.textAlign = 'center';

    overlay.innerHTML = `
      <div style="background: #222225; border: 1.5px solid #d8513a; border-radius: 12px; padding: 36px 24px; max-width: 440px; box-shadow: 0 12px 30px rgba(0,0,0,0.6);">
        <div style="font-size: 36px; margin-bottom: 12px;">⚠️</div>
        <h2 style="color: #ededee; margin-bottom: 12px; font-weight: 700; font-size: 20px;">Critical Update Required</h2>
        <p style="margin-bottom: 24px; font-size: 14px; line-height: 1.5; color: #a6a6ac;">
          A critical security update (v${info.version}) is required to continue. Please click the button below to restart and update IYDANI.
        </p>
        <button id="btnCriticalUpdate" style="background: #d8513a; color: white; border: none; padding: 12px 32px; font-size: 13.5px; font-weight: 700; border-radius: 8px; cursor: pointer; transition: background 0.2s; width: 100%;">
          Restart & Update Now
        </button>
      </div>
    `;

    document.body.appendChild(overlay);

    document.getElementById('btnCriticalUpdate').addEventListener('click', () => {
      updater.install();
    });
  } else {
    // Show top-bar banner
    const banner = document.createElement('div');
    banner.id = 'updater-banner';
    banner.style.position = 'fixed';
    banner.style.top = '0';
    banner.style.left = '0';
    banner.style.right = '0';
    banner.style.background = 'var(--accent, #2f6fe0)';
    banner.style.color = '#ffffff';
    banner.style.zIndex = '9998';
    banner.style.display = 'flex';
    banner.style.alignItems = 'center';
    banner.style.justifyContent = 'center';
    banner.style.gap = '16px';
    banner.style.padding = '10px 20px';
    banner.style.fontSize = '13.5px';
    banner.style.fontWeight = '500';
    banner.style.boxShadow = '0 2px 10px rgba(0,0,0,0.2)';

    banner.innerHTML = `
      <span>Version v${info.version} is ready to install!</span>
      <button id="btnNormalUpdate" style="background: #ffffff; color: var(--accent, #2f6fe0); border: none; padding: 5px 14px; font-size: 12px; font-weight: 700; border-radius: 6px; cursor: pointer;">
        Restart & Update
      </button>
      <button id="btnNormalUpdateClose" style="background: transparent; color: rgba(255, 255, 255, 0.8); border: none; font-size: 16px; cursor: pointer; padding: 2px 8px; margin-left: 10px;">
        ✕
      </button>
    `;

    document.body.appendChild(banner);

    document.getElementById('btnNormalUpdate').addEventListener('click', () => {
      updater.install();
    });

    document.getElementById('btnNormalUpdateClose').addEventListener('click', () => {
      banner.remove();
    });
  }
}
