// Header: live HH:MM:SS clock.

let clockEl = null;

export function init() {
  clockEl = document.getElementById('clock');
}

export function render() {
  if (!clockEl) return;
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const text = `${hh}:${mm}:${ss}`;
  if (clockEl.textContent !== text) clockEl.textContent = text;
}
