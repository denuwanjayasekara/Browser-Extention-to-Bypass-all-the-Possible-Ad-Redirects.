chrome.runtime.sendMessage({ type: 'GET_HOSTS' }, (resp) => {
  if (!resp) return;

  // Seed
  const seedGrid = document.getElementById('seed-hosts');
  document.getElementById('seed-count').textContent = resp.seed.length;
  resp.seed.forEach(h => {
    const el = document.createElement('span');
    el.className = 'pill';
    el.textContent = h;
    seedGrid.appendChild(el);
  });

  // Learned
  const learnedList = document.getElementById('learned-hosts');
  document.getElementById('learned-count').textContent = resp.learned.length;

  if (resp.learned.length > 0) {
    learnedList.innerHTML = '';
    resp.learned.forEach((h, i) => {
      const row = document.createElement('div');
      row.className = 'learned-row';

      const host = document.createElement('span');
      host.className = 'host';
      host.textContent = h;

      // Mark the most recent 3 as "new"
      if (i >= resp.learned.length - 3) {
        const tag = document.createElement('span');
        tag.className = 'new-tag';
        tag.textContent = 'new';
        host.appendChild(tag);
      }

      const btn = document.createElement('button');
      btn.className = 'remove-btn';
      btn.textContent = '✕';
      btn.title = 'Remove ' + h;
      btn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'REMOVE_HOST', host: h }, () => {
          row.remove();
          const cnt = document.getElementById('learned-count');
          cnt.textContent = Math.max(0, parseInt(cnt.textContent) - 1);
          if (learnedList.children.length === 0) {
            learnedList.innerHTML = '<div class="empty">None yet — will populate as you browse.</div>';
          }
        });
      });

      row.appendChild(host);
      row.appendChild(btn);
      learnedList.appendChild(row);
    });
  }
});
